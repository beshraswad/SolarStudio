"""Reproduce geometry, hourly aggregation, and (optionally) neighborhood checks."""
import argparse
import csv
import io
from pathlib import Path

import numpy as np

from solar import DEFAULT, Scene, VILLA, read_step
from study import components, surface_study
from study_exports import hourly_csv


def rectangle(x0,x1,y0,y1,z):
    a,b,c,d = [x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]
    return [[a,b,c],[a,c,d]]


def simple_checks():
    patches = rectangle(0,1,0,1,0)+rectangle(2,3,0,1,0)
    ceiling = rectangle(-.25,1.25,-.25,1.25,1)
    config = dict(patches=patches,normals=[[0,0,1]]*4)
    open_scene = Scene(dict(config,triangles=patches))
    shadow_scene = Scene(dict(config,triangles=patches+ceiling))
    rays = np.array([[0.,0.,1.]])
    rad = np.array([[900.],[800.],[100.]])
    left = np.array([0,1])
    right = np.array([2,3])
    weights = np.array([.5,.5])
    open_values = components(open_scene,left,weights,rays,rad)
    assert np.allclose(open_values[:,0],[800,100,0,900,1])
    assert components(shadow_scene,left,weights,rays,rad)[0,0] == 0
    assert components(shadow_scene,right,weights,rays,rad)[0,0] == 800
    fine = [tri for i in range(4) for j in range(4)
            for tri in rectangle(i/4,(i+1)/4,j/4,(j+1)/4,0)]
    fine_scene = Scene(dict(patches=fine,normals=[[0,0,1]]*len(fine),triangles=patches+ceiling))
    assert components(fine_scene,np.arange(len(fine)),np.full(len(fine),1/len(fine)),rays,rad)[0,0]==0
    print("Unobstructed 900 W/m2; geometric shadow 0 / 800 W/m2 beam; 2 to 32 samples preserve full shadow.")


def verify_profile(profile, name):
    rows = list(csv.DictReader(io.StringIO(hourly_csv(profile,name))))
    for face in profile["faces"]:
        group = [r for r in rows if int(r["face_id"])==face["id"] and r["scenario"]=="with obstructions"]
        assert len(group)==profile["hours"]
        assert abs(sum(float(r["total_W_m2"]) for r in group)/1000-face["energy"])<1e-6
        assert all(abs(sum(float(r[k]) for k in ("beam_W_m2","diffuse_W_m2","ground_W_m2"))
                       -float(r["total_W_m2"]))<1e-6 for r in group)
    assert abs(sum(float(r["incident_kWh_per_hour"]) for r in rows
                   if r["scenario"]=="with obstructions")-profile["incident"])<.001


def run(neighborhood):
    simple_checks()
    model = read_step(VILLA)
    params = dict(date="2024-03-20",offset="+04:00",period="day",faces=[5,14],
                  instant="2024-03-20T10:30:00+04:00")
    profile = surface_study(model,Scene(model),DEFAULT,params,full=True)
    assert profile["hours"]==24 and len(profile["faces"])==2
    verify_profile(profile,"Villa")
    print("Face and CSV components, 24 interval sums, area-weighted and incident energy agree.")
    if neighborhood:
        model = read_step(neighborhood)
        assert len(set(model["faceObjects"].values()))==7
        target = model["faceObjects"][5]
        scene = Scene(model)
        profile = surface_study(model,scene,DEFAULT,dict(params,compare=True,targets=[target],period="year"))
        assert profile["faces"][0]["delta"]<0 and profile["faces"][0]["blockers"]
        print("Neighborhood face 6 annual delta:",round(profile["faces"][0]["delta"],2),"kWh/m²")
        print("10:30 obstruction attribution:",profile["faces"][0]["blockers"])
        changed = surface_study(model,scene,DEFAULT,dict(params,compare=True,targets=[target],faces=[5,9999]))
        assert changed["faces"][0]["id"]==6 and changed["unmatched"]==[10000]
    scene = Scene(model)
    equipment = surface_study(model,scene,DEFAULT,dict(params,absorptivity=.6),full=True)
    for face in equipment["faces"]:
        assert np.allclose(face["heat"],np.asarray(face["series"][3])*face["area"]*.6)
    assert np.isclose(equipment["absorbed"],.6*equipment["incident"])
    rows = csv.DictReader(io.StringIO(hourly_csv(equipment,"STEP equipment")))
    assert np.isclose(sum(float(row["absorbed_W"]) for row in rows)/1000,equipment["absorbed"])
    assert surface_study(model,scene,DEFAULT,dict(params,absorptivity=0))["absorbed"]==0
    print("Hourly absorbed heat agrees with irradiance times face area times absorptivity.")


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--neighborhood",type=Path)
    run(parser.parse_args().neighborhood)

