"""Run a resolution sensitivity check for the villa, retaining all CAD occluders."""
import argparse
import json

import numpy as np
import pandas as pd

from solar import DEFAULT, VILLA, Scene, read_step, sun


def subset(model, refine):
    result = {**model, **{key: [] for key in ("patches", "normals", "faces")}}
    for triangle, normal, face in zip(model["patches"], model["normals"], model["faces"]):
        if face not in (6, 7, 14):
            continue
        triangles = [triangle]
        if face == 7:
            for _ in range(refine):
                refined = []
                for a, b, c in np.asarray(triangles):
                    ab, bc, ca = (a+b)/2, (b+c)/2, (c+a)/2
                    refined.extend(([a,ab,ca], [ab,b,bc], [ca,bc,c], [ab,bc,ca]))
                triangles = refined
        result["patches"].extend(triangles)
        result["faces"].extend([face]*len(triangles))
        result["normals"].extend([normal]*len(triangles))
    return result


def evaluate(model, substeps, sky_rays, refinement):
    local = subset(model, refinement)
    scene = Scene(local, sky_samples=sky_rays)
    annual = scene.annual(DEFAULT, substeps=substeps)
    faces = np.asarray(local["faces"])
    triangles = np.asarray(local["patches"])
    areas = np.linalg.norm(np.cross(triangles[:,1]-triangles[:,0],triangles[:,2]-triangles[:,0]),axis=1)/2
    total, opened = (np.asarray(annual[k]) for k in ("total","open"))
    loss = (opened-total)/opened*100
    connecting = np.flatnonzero(faces==7)
    darkest = connecting[np.argmax(loss[connecting])]
    result = dict(flat_patches=len(connecting), substeps=substeps, sky_rays=sky_rays,
                  peak_flat_loss_pct=round(float(loss[darkest]),2),
                  hotspot_m=scene.centers[darkest].round(3).tolist())
    for label, face in (("flat_mean",7),("south_mean",14),("west_mean",6)):
        selected = faces==face
        result[label] = round(float(np.average(total[selected],weights=areas[selected])),2)
    return result


def check_rays(model, point):
    scene = Scene(subset(model, 0))
    index = np.argmin(np.linalg.norm(scene.centers-point, axis=1))
    origin = scene.origins[index]
    triangles = np.asarray(model["triangles"])
    a = triangles[:,0]
    u, v = triangles[:,1]-a, triangles[:,2]-a
    times = pd.to_datetime(["2024-03-20T05:30Z","2024-03-20T08:30Z","2024-03-20T12:30Z"])
    _, directions = sun(times, DEFAULT["lat"], DEFAULT["lon"], DEFAULT["north"])
    for when, direction in zip(times, directions):
        h = np.cross(direction,v)
        d = np.einsum("ij,ij->i",u,h)
        valid = abs(d)>1e-10
        s = origin-a
        q = np.cross(s,u)
        x = np.divide(np.einsum("ij,ij->i",s,h),d,out=np.zeros_like(d),where=valid)
        y = np.divide(q@direction,d,out=np.zeros_like(d),where=valid)
        t = np.divide(np.einsum("ij,ij->i",v,q),d,out=np.zeros_like(d),where=valid)
        hit = valid & (x>=0) & (y>=0) & (x+y<=1) & (t>1e-6)
        assert bool(hit.any()) == (not scene.visible(direction)[index])
        print(json.dumps(dict(utc=when.isoformat(),point_m=scene.centers[index].round(3).tolist(),
                              blocked=bool(hit.any()), distance_m=round(float(t[hit].min()),3) if hit.any() else None)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--substeps", type=int, choices=(1,2,4,6,12), default=4)
    parser.add_argument("--sky-rays", type=int, choices=(256,512,1024,2048,4096), default=1024)
    parser.add_argument("--refine", type=int, choices=(0,1,2), default=1)
    args = parser.parse_args()
    model = read_step(VILLA)
    baseline = evaluate(model,1,256,0)
    check_rays(model,baseline["hotspot_m"])
    for substeps, sky_rays, refinement in dict.fromkeys([
        (1,256,0), (args.substeps,256,0), (1,args.sky_rays,0),
        (1,256,args.refine), (args.substeps,args.sky_rays,args.refine),
    ]):
        result = baseline if (substeps,sky_rays,refinement)==(1,256,0) else evaluate(model,substeps,sky_rays,refinement)
        print(json.dumps(result),flush=True)

