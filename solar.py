"""STEP tessellation and hourly, patch-level solar irradiation."""
import json
import math
from pathlib import Path
from tempfile import NamedTemporaryFile

import numpy as np
import pandas as pd
import pvlib
import requests
from base64 import b64encode
from embreex.mesh_construction import TriangleMesh
from embreex.rtcore_scene import EmbreeScene
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
POWER = "https://power.larc.nasa.gov/api/temporal/hourly/point"
FIELDS = ("ALLSKY_SFC_SW_DWN", "ALLSKY_SFC_SW_DNI", "ALLSKY_SFC_SW_DIFF")
DEFAULT = dict(lat=24.4539, lon=54.3773, year=2024, north=0)
VILLA = ROOT / "data" / "Abu_Dhabi_Villa_Solar_Demo.step"


def read_step(path):
    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError("Could not read the STEP file.")
    Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        raise ValueError("The STEP file contains no transferable geometry.")
    BRepMesh_IncrementalMesh(shape, 25.0, False, 0.3, True)
    solids = TopExp_Explorer(shape, TopAbs_SOLID)
    object_map = {}
    solid_count = 0
    while solids.More():
        solid_count += 1
        members = TopExp_Explorer(solids.Current(), TopAbs_FACE)
        while members.More():
            object_map.setdefault(hash(members.Current()), solid_count)
            members.Next()
        solids.Next()
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    triangles, face_ids, edges, edge_faces = [], [], [], []
    face_id = 0
    face_objects = {}
    while faces.More():
        face = TopoDS.Face(faces.Current())
        face_objects[face_id] = object_map.get(hash(face), 0)
        loc = TopLoc_Location()
        mesh = BRep_Tool.Triangulation_s(face, loc)
        if mesh is not None:
            transform = loc.Transformation()
            nodes = [mesh.Node(i).Transformed(transform).Coord()
                     for i in range(1, mesh.NbNodes() + 1)]
            counts = {}
            for i in range(1, mesh.NbTriangles() + 1):
                a, b, c = mesh.Triangle(i).Get()
                for x, y in ((a, b), (b, c), (c, a)):
                    key = tuple(sorted((x, y)))
                    counts[key] = counts.get(key, 0) + 1
                if face.Orientation() == TopAbs_REVERSED:
                    b, c = c, b
                triangles.append([nodes[a-1], nodes[b-1], nodes[c-1]])
                face_ids.append(face_id)
            for (a, b), count in counts.items():
                if count == 1:
                    edges.append([nodes[a-1], nodes[b-1]])
                    edge_faces.append(face_id)
        faces.Next()
        face_id += 1
    if not triangles or len(triangles) > 25000:
        raise ValueError("A STEP model must have 1–25,000 tessellated triangles.")
    geometry = np.asarray(triangles) / 1000
    low, high = geometry.min(axis=(0, 1)), geometry.max(axis=(0, 1))
    offset = np.array([*(low[:2] + high[:2]) / 2, low[2]])
    geometry -= offset
    cross = np.cross(geometry[:, 1] - geometry[:, 0], geometry[:, 2] - geometry[:, 0])
    valid = np.linalg.norm(cross, axis=1) > 1e-9
    geometry, cross = geometry[valid], cross[valid]
    if not len(geometry):
        raise ValueError("The STEP model has no nondegenerate surfaces.")
    normals = cross / np.linalg.norm(cross, axis=1, keepdims=True)
    spacing = max(0.85, float(np.max(high-low)) / 34)
    patches, patch_normals, groups, types = [], [], [], []
    for tri, normal, group in zip(geometry, normals, np.asarray(face_ids)[valid]):
        if normal[2] < -0.12:
            continue
        a, b, c = tri
        longest = max(np.linalg.norm(b-a), np.linalg.norm(c-a), np.linalg.norm(c-b))
        divisions = min(36, max(1, math.ceil(longest / spacing)))
        u, v = (b-a)/divisions, (c-a)/divisions
        for i in range(divisions):
            for j in range(divisions-i):
                p = a+i*u+j*v
                patches.append([p, p+u, p+v])
                if i+j < divisions-1:
                    patches.append([p+u, p+u+v, p+v])
        count = divisions**2
        patch_normals.extend([normal]*count)
        groups.extend([int(group)]*count)
        types.extend(["roof" if normal[2] > 0.25 else "wall"]*count)
        if len(patches) > 24000:
            raise ValueError("The model exceeds 24,000 analysis patches.")
    if not patches:
        raise ValueError("No upward-facing or vertical analysis surfaces found.")
    edge_array = np.asarray(edges).reshape(-1, 2, 3)/1000-offset
    roof_faces = {group for group, kind in zip(groups, types) if kind == "roof"}
    return {
        "triangles": geometry.round(6).tolist(),
        "triangleFaces": np.asarray(face_ids)[valid].tolist(),
        "faceObjects": face_objects,
        "patches": np.asarray(patches).round(6).tolist(),
        "normals": np.asarray(patch_normals).round(8).tolist(),
        "faces": groups, "types": types,
        "edges": edge_array.round(6).tolist(),
        "roofEdges": edge_array[np.array([i in roof_faces for i in edge_faces], dtype=bool)].round(6).tolist(),
        "size": (high-low).round(3).tolist(),
    }


def weather(lat, lon, year):
    lat, lon = round(lat, 4), round(lon, 4)
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{lat:.4f}_{lon:.4f}_{year}.json"
    hours = pd.date_range(f"{year}-01-01", f"{year+1}-01-01", freq="h",
                          tz="UTC", inclusive="left")
    keys = hours.strftime("%Y%m%d%H")

    def extract(payload):
        series = payload["properties"]["parameter"]
        values = np.array([[series[field][key] for key in keys] for field in FIELDS])
        if not np.isfinite(values).all() or np.any(values < -1):
            raise ValueError("NASA POWER returned missing irradiation data.")
        units = [payload["parameters"][field]["units"] for field in FIELDS]
        if any(unit not in ("Wh/m^2", "W/m^2") for unit in units):
            raise ValueError(f"Unexpected NASA POWER hourly units: {units}")
        return hours + pd.Timedelta(minutes=30), np.maximum(values, 0)

    try:
        return extract(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, KeyError, ValueError, TypeError):
        pass
    response = requests.get(POWER, timeout=(15, 150), params={
        "parameters": ",".join(FIELDS), "community": "RE", "format": "JSON",
        "latitude": lat, "longitude": lon, "time-standard": "UTC",
        "start": f"{year}0101", "end": f"{year}1231",
    })
    response.raise_for_status()
    payload = response.json()
    try:
        result = extract(payload)
    except (KeyError, ValueError, TypeError) as error:
        raise ValueError("NASA POWER did not supply a complete year of hourly GHI, DNI and DHI.") from error
    with NamedTemporaryFile(mode="w", dir=CACHE, encoding="utf-8", delete=False) as temp:
        json.dump(payload, temp, separators=(",", ":"))
    Path(temp.name).replace(path)
    return result


def sun(times, lat, lon, north):
    positions = pvlib.solarposition.get_solarposition(times, lat, lon)
    bearing = np.radians(positions.azimuth.to_numpy() + north)
    elevation = np.radians(positions.apparent_elevation.to_numpy())
    vectors = np.column_stack((np.sin(bearing)*np.cos(elevation),
                               np.cos(bearing)*np.cos(elevation), np.sin(elevation)))
    return positions, vectors


def solar_day(start, lat, lon, north, average=False):
    """Sample local clock time across a day or average vectors across a month."""
    start = start.normalize()
    days = start.days_in_month if average else 1
    minutes = np.arange(0, 1441, 15)
    offsets = np.arange(days)[:, None] * 1440 + minutes
    times = start + pd.to_timedelta(offsets.ravel(), unit="min")
    _, vectors = sun(times, lat, lon, north)
    directions = vectors.reshape(days, len(minutes), 3).mean(axis=0)
    directions /= np.linalg.norm(directions, axis=1, keepdims=True)
    elevation = np.degrees(np.arcsin(np.clip(directions[:, 2], -1, 1)))
    azimuth = (np.degrees(np.arctan2(directions[:, 0], directions[:, 1])) - north) % 360
    return minutes, directions, elevation, azimuth


def clear_sky(elevation):
    """Illustrative sea-level clear sky for the live power map."""
    zenith = 90 - np.asarray(elevation)
    airmass = pvlib.atmosphere.get_relative_airmass(zenith)
    sky = pvlib.clearsky.ineichen(zenith, airmass, linke_turbidity=3)
    return np.column_stack([np.nan_to_num(sky[key]) for key in ("ghi", "dni", "dhi")])


class Scene:
    def __init__(self, model, sky_samples=256):
        triangles = np.asarray(model["triangles"], dtype=np.float32)
        self.normals = np.asarray(model["normals"], dtype=np.float64)
        self.centers = np.asarray(model["patches"]).mean(axis=1)
        self.origins = (self.centers + self.normals * 0.0002).astype(np.float32)
        self.accel = EmbreeScene()
        TriangleMesh(self.accel, triangles.reshape(-1, 3),
                     np.arange(triangles.size//3, dtype=np.int32).reshape(-1, 3))
        # The first query commits the scene before preview and annual runs can overlap.
        self.accel.run(self.origins[:1], np.array([[0, 0, 1]], dtype=np.float32))
        self.sky_open = (1 + self.normals[:, 2])/2
        self.ground_open = 1-self.sky_open
        self.sky_factor = self.view_factor(1, self.sky_open, sky_samples)
        self.ground_factor = self.view_factor(-1, self.ground_open, sky_samples)

    def view_factor(self, sign, open_factor, sample_count):
        """Stratified hemispherical quadrature, corrected to the analytical open limit."""
        samples = np.arange(sample_count)
        z = (samples+.5)/len(samples)
        phi = samples*np.pi*(3-np.sqrt(5))
        r = np.sqrt(1-z*z)
        directions = np.column_stack((r*np.cos(phi), r*np.sin(phi), sign*z)).astype(np.float32)
        factors = open_factor.copy()
        for start in range(0, len(self.centers), 128):
            block = self.normals[start:start+128]
            weights = np.maximum(np.einsum("ik,jk->ij", block, directions), 0)
            patches, rays = np.nonzero(weights)
            if len(patches):
                blocked = self.accel.run(self.origins[start+patches], directions[rays]) >= 0
                weights_sum = weights.sum(axis=1)
                loss = np.bincount(patches[blocked], weights=weights[patches[blocked], rays[blocked]],
                                   minlength=len(block))
                factors[start:start+len(block)] *= 1-np.divide(
                    loss, weights_sum, out=np.zeros_like(weights_sum), where=weights_sum > 0)
        return np.clip(factors, 0, open_factor)

    def factors(self):
        return {"skyFactor": self.sky_factor.round(8).tolist(),
                "groundFactor": self.ground_factor.round(8).tolist()}

    def visible(self, direction):
        incidence = self.normals @ direction
        lit = np.zeros(len(self.centers), dtype=bool)
        if direction[2] > 0:
            visible = np.flatnonzero(incidence > 0)
            if len(visible):
                rays = np.repeat(direction[None, :], len(visible), axis=0).astype(np.float32)
                lit[visible] = self.accel.run(self.origins[visible], rays) < 0
        return lit

    def playback(self, start, lat, lon, north, average):
        minutes, directions, elevation, azimuth = solar_day(start, lat, lon, north, average)
        weather = clear_sky(elevation)
        return [
            dict(minute=int(minute), direction=direction.tolist(),
                 elevation=round(float(el), 2), azimuth=round(float(az), 2),
                 irradiance=radiation.round(2).tolist(),
                 mask=b64encode(np.packbits(self.visible(direction), bitorder="little")).decode("ascii"))
            for minute, direction, el, az, radiation in zip(minutes, directions, elevation, azimuth, weather)
        ]

    def annual(self, settings, substeps=1):
        lat, lon, year, north = (settings[key] for key in ("lat", "lon", "year", "north"))
        times, (ghi, dni, dhi) = weather(lat, lon, year)
        hour_count = len(times)
        if substeps > 1:
            offsets = (np.arange(substeps)+.5)/substeps-.5
            times = times.repeat(substeps) + pd.to_timedelta(np.tile(offsets, hour_count), unit="h")
            ghi, dni, dhi = (np.repeat(values/substeps, substeps) for values in (ghi, dni, dhi))
        _, vectors = sun(times, lat, lon, north)
        active = vectors[:, 2] > 0
        rays, beam = vectors[active], dni[active]
        diffuse = dhi.sum()*self.sky_factor/1000
        ground = ghi.sum()*0.2*self.ground_factor/1000
        direct = np.zeros(len(self.centers))
        unshaded = np.zeros(len(self.centers))
        sun_hours = np.zeros(len(self.centers), dtype=int)
        directions = rays.astype(np.float32)
        # Submit bounded batches of front-facing rays to the triangle BVH.
        for start in range(0, len(self.centers), 48):
            end = start + 48
            block = self.normals[start:end]
            incidence = np.einsum("ik,jk->ij", block, rays)
            plane = np.maximum(incidence, 0) * beam / 1000
            unshaded[start:end] = plane.sum(axis=1)
            patch, hour = np.nonzero(incidence > 0)
            if not len(patch):
                continue
            visible = self.accel.run(self.origins[start+patch], directions[hour]) < 0
            direct[start:end] = np.bincount(
                patch[visible], weights=plane[patch[visible], hour[visible]], minlength=len(block)
            )
            sun_hours[start:end] = np.bincount(patch[visible], minlength=len(block))
        total = direct + diffuse + ground
        open_diffuse = dhi.sum()*self.sky_open/1000
        open_ground = ghi.sum()*0.2*self.ground_open/1000
        open_total = unshaded + open_diffuse + open_ground
        scale = max(250, math.ceil(total.max()/250)*250)
        return {
            "total": total.round(2).tolist(), "direct": direct.round(2).tolist(),
            "diffuse": diffuse.round(2).tolist(), "ground": ground.round(2).tolist(),
            "loss": (unshaded-direct).round(2).tolist(), "scale": scale,
            "open": open_total.round(2).tolist(), "sunHours": (sun_hours if substeps == 1 else sun_hours/substeps).tolist(),
            "diffuseLoss": (open_diffuse-diffuse).round(2).tolist(),
            "groundLoss": (open_ground-ground).round(2).tolist(),
            "hours": hour_count, "settings": settings,
        }

    def hourly(self, config, index):
        times, (ghi, dni, dhi) = weather(config["lat"], config["lon"], config["year"])
        positions, rays = sun(times, config["lat"], config["lon"], config["north"])
        cosine = rays @ self.normals[index]
        active = (cosine > 0) & (rays[:, 2] > 0)
        visible = np.zeros(len(times), dtype=int)
        if active.any():
            origins = np.repeat(self.origins[index:index+1], active.sum(), axis=0)
            visible[active] = self.accel.run(origins, rays[active].astype(np.float32)) < 0
        direct = dni*np.maximum(cosine, 0)*visible
        diffuse = dhi*self.sky_factor[index]
        ground = .2*ghi*self.ground_factor[index]
        open_beam = dni*np.maximum(cosine, 0)*(rays[:, 2] > 0)
        open_poa = open_beam+dhi*self.sky_open[index]+.2*ghi*self.ground_open[index]
        return zip(times.strftime("%Y-%m-%dT%H:%M:%SZ"), ghi, dni, dhi, positions.apparent_elevation,
                   positions.apparent_zenith, positions.azimuth, cosine, visible, direct,
                   diffuse, ground, direct+diffuse+ground, open_beam-direct, open_poa)

