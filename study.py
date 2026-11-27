"""Area-weighted face and equipment exposure using the existing ray scene."""
import math
from datetime import timedelta, timezone

import numpy as np
import pandas as pd

from solar import Scene, sun, weather


def climate(config, data):
    day = pd.Timestamp(data["date"]).date()
    offset = str(data["offset"])
    if len(offset)!=6 or offset[0] not in "+-" or offset[3]!=":":
        raise ValueError("Enter a UTC offset such as +04:00.")
    hours, minutes = int(offset[1:3]), int(offset[4:])
    if hours>14 or minutes>59 or (hours==14 and minutes):
        raise ValueError("Invalid UTC offset.")
    tz = timezone(timedelta(minutes=(hours*60+minutes)*(1 if offset[0]=="+" else -1)))
    times, rad = weather(config["lat"],config["lon"],config["year"])
    times = times.tz_convert(tz)
    daily = np.asarray(times.date)==day
    if data["period"] not in ("day","year") or not daily.any():
        raise ValueError("Choose a date in the weather record.")
    mask = daily if data["period"]=="day" else np.ones(len(times),dtype=bool)
    _, rays = sun(times[mask],config["lat"],config["lon"],config["north"])
    return times[mask], rays, rad[:,mask], daily[mask], offset


def areas(triangles):
    a,b,c = np.asarray(triangles).transpose(1,0,2)
    return np.linalg.norm(np.cross(b-a,c-a),axis=1)/2


def components(scene, ids, weights, rays, rad):
    ghi,dni,dhi = rad
    beam, visible = np.zeros(len(rays)), np.zeros(len(rays))
    daylight = rays[:,2]>0
    for start in range(0,len(ids),48):
        part = ids[start:start+48]
        w = weights[start:start+48]
        dot = np.einsum("pi,hi->ph",scene.normals[part],rays)
        p,h = np.nonzero((dot>0)&daylight)
        if len(h):
            lit = scene.accel.run(scene.origins[part[p]],rays[h].astype(np.float32))<0
            p,h = p[lit],h[lit]
            beam += np.bincount(h,weights=w[p]*dot[p,h]*dni[h],minlength=len(rays))
            visible += np.bincount(h,weights=w[p],minlength=len(rays))
    diffuse = dhi*(weights@scene.sky_factor[ids])
    ground = .2*ghi*(weights@scene.ground_factor[ids])
    return np.array([beam,diffuse,ground,beam+diffuse+ground,visible])


def shadow_sources(model,scene,ids,weights,direction,targets):
    front = (scene.normals[ids]@direction > 0) & (direction[2]>0)
    if not front.any():
        return []
    hits = scene.accel.run(scene.origins[ids[front]],
                          np.repeat(direction[None,:],front.sum(),axis=0).astype(np.float32))
    groups = {}
    for hit,weight in zip(hits,weights[front]):
        if hit>=0:
            obj = model["faceObjects"][model["triangleFaces"][hit]]
            if obj not in targets:
                groups[obj] = groups.get(obj,0)+float(weight)
    return [{"object":i,"percent":100*v} for i,v in sorted(groups.items(),key=lambda x:-x[1])]


def surface_study(model, scene, config, data, full=False):
    times,rays,rad,day,offset = climate(config,data)
    requested = list(dict.fromkeys(map(int,data["faces"])))
    if not 1<=len(requested)<=12:
        raise ValueError("Select one to twelve faces.")
    by_face = np.asarray(model["faces"])
    objects = model["faceObjects"]
    alpha = float(data["absorptivity"]) if "absorptivity" in data else None
    if alpha is not None and not 0 <= alpha <= 1:
        raise ValueError("Absorptivity must be between 0 and 1.")
    targets = set(map(int,data.get("targets",[])))
    if targets-set(objects.values()):
        raise ValueError("A target object is unavailable.")
    reference, direction = None, None
    if targets and data.get("compare"):
        reference = [t for t,f in zip(model["triangles"],model["triangleFaces"]) if objects[f] in targets]
        instant = pd.Timestamp(data["instant"])
        if instant.tzinfo is None:
            raise ValueError("The selected instant needs a timezone.")
        direction = sun(pd.DatetimeIndex([instant]),config["lat"],config["lon"],config["north"])[1][0]
    result, unmatched = [], []
    show = slice(None) if full else day
    for face in requested:
        ids = np.flatnonzero(by_face==face)
        if not len(ids) or (targets and objects[face] not in targets):
            unmatched.append(face+1)
            continue
        triangles = np.asarray(model["patches"])[ids]
        a = areas(triangles)
        area = float(a.sum())
        weights = a/area
        normal = weights@scene.normals[ids]
        normal /= np.linalg.norm(normal)
        values = components(scene,ids,weights,rays,rad)
        peak = int(values[3].argmax())
        item = dict(id=face+1,object=objects[face],area=area,tilt=math.degrees(math.acos(np.clip(normal[2],-1,1))),
                    azimuth=(math.degrees(math.atan2(*normal[:2]))-config["north"])%360 if np.linalg.norm(normal[:2])>1e-7 else None,
                    hours=float(values[4].sum()),peak=float(values[3,peak]),peakTime=times[peak].isoformat(),
                    energy=float(values[3].sum()/1000),series=values[:,show].tolist())
        if alpha is not None:
            heat = values[3]*area*alpha
            item.update(heat=heat[show].tolist(), peakHeat=float(heat.max()),
                        absorbed=float(heat.sum()/1000))
        if reference is not None:
            base = Scene(dict(triangles=reference,patches=triangles,normals=scene.normals[ids]))
            before = components(base,np.arange(len(ids)),weights,rays,rad)
            item.update(baselineEnergy=float(before[3].sum()/1000),baseline=before[:,show].tolist(),
                        blockers=shadow_sources(model,scene,ids,weights,direction,targets))
            item["delta"] = item["energy"]-item["baselineEnergy"]
        result.append(item)
    area = sum(f["area"] for f in result)
    incident = sum(f["area"]*f["energy"] for f in result)
    return dict(faces=result,timestamps=[t.isoformat() for t in times[show]],hours=len(times),
                area=area,incident=incident,mean=incident/area if area else None,unmatched=unmatched,
                settings=config,timezone=offset,first=times[0].isoformat(),last=times[-1].isoformat(),
                source="NASA POWER hourly (GHI, DNI, DHI)", absorptivity=alpha,
                absorbed=incident*alpha if alpha is not None else None)
