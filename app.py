"""Local web server for Solar Studio."""
import csv
import io
import json
import math
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import lru_cache
from itertools import islice
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic

import numpy as np
from requests import RequestException
import pandas as pd
from flask import Flask, Response, jsonify, request
from panels import layout
from figure_report import FIGURES, annual_frame, generate, patch_frame, selected_frame
from study import surface_study
from study_exports import hourly_csv as face_csv, report as face_report

from solar import DEFAULT, ROOT, VILLA, Scene, clear_sky, read_step, solar_day, sun

app = Flask(__name__, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
models = {}
jobs = {}
placements = OrderedDict()
figure_reports = OrderedDict()
figure_lock = Lock()
results_lock = Lock()
executor = ThreadPoolExecutor(max_workers=1)
import_lock = Lock()


def load_villa():
    model = read_step(VILLA)
    model.update(id="villa", name="Abu Dhabi Villa", filename=VILLA.name)
    scene = Scene(model)
    model.update(scene.factors())
    models["villa"] = (model, scene)
    return model


def get_model(model_id):
    if model_id == "villa" and model_id not in models:
        with import_lock:
            if model_id not in models:
                load_villa()
    if model_id not in models:
        raise ValueError("Load a STEP model first.")
    return models[model_id]


def settings(data):
    lat, lon, north = (float(data[k]) for k in ("lat", "lon", "north"))
    year = int(data["year"])
    if not all(map(math.isfinite, (lat, lon, north))):
        raise ValueError("Enter finite coordinates and a north bearing.")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180 and 2001 <= year < pd.Timestamp.now().year):
        raise ValueError("Use valid coordinates and a completed weather year from 2001 onward.")
    return dict(lat=round(lat, 4), lon=round(lon, 4), year=year, north=north % 360)


@lru_cache(maxsize=1)
def bundled_results():
    return json.loads((ROOT / "data" / "villa-results.json").read_text(encoding="utf-8"))


def prune_jobs():
    cutoff = monotonic() - 3600
    for key, (_, _, future, created) in list(jobs.items()):
        if future.done() and created < cutoff:
            del jobs[key]


def completed_analysis(data, config):
    analysis = data.get("analysis")
    if analysis == "villa-default":
        model_id, result = "villa", bundled_results()
    else:
        with results_lock:
            prune_jobs()
            record = jobs.get(analysis)
        if record is None or not record[2].done() or record[2].exception() is not None:
            raise ValueError("The analysis is unavailable. Run annual analysis again.")
        model_id, _, future, _ = record
        result = future.result()
    if model_id != data["model"] or result["settings"] != config:
        raise ValueError("The analysis does not match this model and site configuration.")
    return result


@app.errorhandler(ValueError)
@app.errorhandler(KeyError)
@app.errorhandler(TypeError)
def bad_input(error):
    return jsonify(error=str(error)), 400


@app.errorhandler(413)
def too_large(error):
    return jsonify(error="The STEP upload limit is 25 MB."), 413


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/calculations")
def calculations():
    return app.send_static_file("calculations.html")


@app.post("/api/study")
def study():
    data = request.get_json()
    model, scene = get_model(data["model"])
    export = data.get("export")
    profile = surface_study(model,scene,settings(data),data,full=export=="csv")
    if export=="csv":
        return Response(face_csv(profile,model["name"]),mimetype="text/csv",
                        headers={"Content-Disposition":"attachment; filename=selected-surfaces.csv"})
    if export=="pdf":
        return Response(face_report(profile,model["name"],data.get("snapshot")),mimetype="application/pdf",
                        headers={"Content-Disposition":"attachment; filename=selected-surfaces.pdf"})
    return jsonify(profile)


@app.post("/api/figure-report")
def figure_report():
    data = request.get_json()
    model, scene = get_model(data["model"])
    config = settings(data)
    tz = datetime.strptime(data["offset"], "%z").tzinfo
    annual = None
    issues = {}
    if data.get("analysis"):
        try:
            annual = annual_frame(model, completed_analysis(data, config), config["north"])
        except ValueError as error:
            issues["annual"] = str(error)
    patch = None
    index = data.get("patch")
    if isinstance(index, int) and 0 <= index < len(model["patches"]):
        try:
            patch = patch_frame(scene, config, index, model["faces"][index]+1)
        except (ValueError, RequestException):
            issues["patch"] = "Hourly weather for this patch is unavailable."
    profile = None
    if data.get("faces"):
        try:
            profile = surface_study(model, scene, config, {**data,"period":"year"}, full=True)
        except ValueError as error:
            issues["selected"] = str(error)
        except RequestException:
            issues["selected"] = "Hourly weather for the selected surfaces is unavailable."
    with figure_lock:
        pdf, pngs = generate(model["name"], config, tz, annual, selected_frame(profile), patch, issues)
        key = uuid.uuid4().hex
        figure_reports[key] = (pdf, pngs)
        while len(figure_reports) > 5:
            figure_reports.popitem(last=False)
    return jsonify(id=key, titles=FIGURES)


@app.get("/api/figure-report/<key>/<asset>")
def figure_asset(key, asset):
    with figure_lock:
        bundle = figure_reports.get(key)
    if bundle is None:
        return jsonify(error="Generate the report again to refresh these figures."), 404
    if asset == "report.pdf":
        return Response(bundle[0], mimetype="application/pdf",
                        headers={"Content-Disposition":"attachment; filename=solar-analysis-report.pdf"})
    if asset.endswith(".png") and asset[:-4].isdigit() and 1 <= int(asset[:-4]) <= 10:
        return Response(bundle[1][int(asset[:-4])-1], mimetype="image/png")
    return jsonify(error="Figure not found."), 404


@app.post("/api/panels")
def panels():
    data = request.get_json()
    model, _ = get_model(data["model"])
    result = completed_analysis(data, settings(data))
    preview = layout(model, data, result["total"])
    identifier = uuid.uuid4().hex
    if preview["count"]:
        summary = {k: preview[k] for k in ("count", "kwp", "generation", "watts", "ratio", "target", "shortfall")}
        summary["poaSum"] = sum(module["poa"] for module in preview["modules"])
        with results_lock:
            placements[identifier] = (data["analysis"], data["model"], summary)
            while len(placements) > 64:
                placements.popitem(last=False)
    return jsonify({**preview, "placement": identifier if preview["count"] else None})


@app.get("/api/model")
def villa():
    with import_lock:
        return jsonify(models["villa"][0] if "villa" in models else load_villa())


@app.post("/api/import")
def import_model():
    upload = request.files.get("model")
    if not upload or Path(upload.filename).suffix.lower() not in (".step", ".stp"):
        raise ValueError("Select a .step or .stp model.")
    with TemporaryDirectory() as directory:
        path = Path(directory) / "model.step"
        upload.save(path)
        with import_lock:
            try:
                model = read_step(path)
            except RuntimeError as error:
                raise ValueError(f"STEP tessellation failed: {error}") from error
        model.update(id=uuid.uuid4().hex, name=Path(upload.filename).stem, filename=upload.filename)
        scene = Scene(model)
        model.update(scene.factors())
        models[model["id"]] = (model, scene)
    return jsonify(model)


@app.get("/api/demo")
def demo():
    return jsonify({**bundled_results(), "analysis": "villa-default"})


@app.post("/api/analyze")
def analyze():
    data = request.get_json()
    config = settings(data)
    _, scene = get_model(data["model"])
    job = uuid.uuid4().hex
    with results_lock:
        prune_jobs()
        if sum(not record[2].done() for record in jobs.values()) >= 4:
            return jsonify(error="The analysis queue is full. Try again after a run finishes."), 429
        while len(jobs) >= 32:
            oldest = next(key for key, record in jobs.items() if record[2].done())
            del jobs[oldest]
        jobs[job] = (data["model"], config, executor.submit(scene.annual, config), monotonic())
    return jsonify(job=job), 202


@app.get("/api/jobs/<job>")
def job_status(job):
    with results_lock:
        prune_jobs()
        record = jobs.get(job)
    if record is None:
        return jsonify(error="Analysis job expired."), 404
    future = record[2]
    if not future.done():
        return jsonify(status="running")
    try:
        return jsonify(status="complete", result={**future.result(), "analysis": job})
    except Exception as error:
        app.logger.exception("Analysis failed")
        return jsonify(error=str(error)), 502


@app.post("/api/preview")
def preview():
    data = request.get_json()
    config = settings(data)
    _, scene = get_model(data["model"])
    instant = pd.Timestamp(data["instant"])
    if instant.tzinfo is None:
        raise ValueError("Preview time requires an explicit UTC offset.")
    coordinates = (config["lat"], config["lon"], config["north"])
    positions, vectors = sun(pd.DatetimeIndex([instant]), *coordinates)
    _, path, _, _ = solar_day(instant, *coordinates)
    point = positions.iloc[0]
    return jsonify(
        azimuth=round(float(point.azimuth), 2),
        elevation=round(float(point.apparent_elevation), 2),
        direction=vectors[0].tolist(), path=path.tolist(),
        irradiance=clear_sky([point.apparent_elevation])[0].round(2).tolist(),
        lit=scene.visible(vectors[0]).tolist(),
    )


@app.post("/api/playback")
def playback():
    data = request.get_json()
    config = settings(data)
    _, scene = get_model(data["model"])
    start = pd.Timestamp(data["start"])
    if start.tzinfo is None:
        raise ValueError("Playback requires an explicit UTC offset.")
    average = data.get("average") is True
    if average and start.day != 1:
        raise ValueError("Monthly playback must start on the first of the month.")
    coordinates = (config["lat"], config["lon"], config["north"])
    return jsonify(frames=scene.playback(start, *coordinates, average))


@app.post("/api/hourly.csv")
def hourly_csv():
    data = request.get_json()
    config = settings(data)
    model, scene = get_model(data["model"])
    patch = int(data["patch"])
    if not 0 <= patch < len(model["patches"]):
        raise ValueError("Select a patch for the hourly CSV.")
    rows = io.StringIO()
    writer = csv.writer(rows)
    writer.writerow(["patch_id", "face_id", "latitude_deg", "longitude_deg", "north_model_deg",
                     "utc_midpoint", "ghi_wh_m2", "dni_wh_m2", "dhi_wh_m2", "sun_elevation_deg",
                     "sun_zenith_deg", "sun_azimuth_deg_true", "incidence_cosine", "direct_sun",
                     "beam_wh_m2", "sky_wh_m2", "ground_wh_m2", "poa_wh_m2", "beam_loss_wh_m2",
                     "open_poa_wh_m2"])
    prefix = [patch+1, model["faces"][patch]+1, config["lat"], config["lon"], config["north"]]
    writer.writerows([*prefix, stamp, *(round(float(v), 7) for v in values)]
                     for stamp, *values in scene.hourly(config, patch))
    return Response(rows.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": f"attachment; filename=patch-{patch+1}-{config['year']}-hourly.csv"})


@app.post("/api/worked-calculation")
def worked_calculation():
    data = request.get_json()
    if not data:
        with import_lock:
            if "villa" not in models:
                load_villa()
        bundled = bundled_results()
        index = bundled["check"]["shaded"]["index"]
        data = dict(DEFAULT, model="villa", patch=index, instant="2024-03-20T15:00:00+04:00",
                    analysis="villa-default")
    config = settings(data)
    model, scene = get_model(data["model"])
    index = int(data["patch"])
    if not 0 <= index < len(model["patches"]):
        raise ValueError("Select a valid surface patch.")
    annual = None
    placement = None
    if data.get("analysis"):
        computed = completed_analysis(data, config)
        ids = np.flatnonzero(np.asarray(model["faces"]) == model["faces"][index])
        tris = np.asarray(model["patches"])[ids]
        areas = np.linalg.norm(np.cross(tris[:,1]-tris[:,0], tris[:,2]-tris[:,0]), axis=1)/2
        annual = {key: computed[key][index] for key in
                  ("direct", "diffuse", "ground", "total", "open", "loss", "sunHours")}
        annual.update(hours=computed["hours"], faceArea=float(areas.sum()),
                      faceWeighted=float(areas @ np.asarray(computed["total"])[ids]))
        if data.get("placement"):
            with results_lock:
                record = placements.get(data["placement"])
            if not record or record[:2] != (data["analysis"], data["model"]):
                raise ValueError("The panel estimate is unavailable for this analysis.")
            placement = record[2]
    patch = model["patches"][index]
    normal = model["normals"][index]
    x, y, z = normal
    delta = -math.radians(config["north"])
    east, north = x*math.cos(delta)+y*math.sin(delta), -x*math.sin(delta)+y*math.cos(delta)
    area = math.dist([0, 0, 0], [
        (patch[1][(j+1)%3]-patch[0][(j+1)%3])*(patch[2][(j+2)%3]-patch[0][(j+2)%3])
        -(patch[1][(j+2)%3]-patch[0][(j+2)%3])*(patch[2][(j+1)%3]-patch[0][(j+1)%3])
        for j in range(3)]) / 2
    result = dict(project=model["name"], patch=index+1, face=model["faces"][index]+1,
                  settings=config, normal=normal, enu=[east, north, z], area=area,
                  tilt=math.degrees(math.acos(max(-1, min(1, z)))),
                  azimuth=math.degrees(math.atan2(east, north)) % 360 if math.hypot(east, north) > 1e-5 else None,
                  sky=float(scene.sky_factor[index]), ground=float(scene.ground_factor[index]),
                  annual=annual, placement=placement)
    if result["annual"]:
        instant = pd.Timestamp(data["instant"])
        if instant.tzinfo is None:
            raise ValueError("The worked hour needs a UTC offset.")
        start = pd.Timestamp(f"{config['year']}-01-01", tz="UTC")
        end = pd.Timestamp(f"{config['year']+1}-01-01", tz="UTC")
        hour = instant.tz_convert("UTC").floor("h")
        clamped = min(max(hour, start), end-pd.Timedelta(hours=1))
        row = int((clamped-start)/pd.Timedelta(hours=1))
        stamp, *values = next(islice(scene.hourly(config, index), row, row+1))
        result["hour"] = dict(zip(("ghi","dni","dhi","elevation","zenith","azimuth","cosine",
                                   "visible","beam","sky","ground","poa","beam_loss","open"), map(float,values)))
        result["hour"].update(midpoint=stamp, requested=instant.isoformat(), clamped=clamped != hour)
    return jsonify(result)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8765, threaded=True)

