"""Flush-mounted module placement on planar STEP roof faces."""
import math

import numpy as np
from shapely import STRtree, box, covers, prepare, union_all
from shapely.geometry import Polygon

EPSILON = 1e-7


def bounded(data, name, low, high):
    value = float(data[name])
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}.")
    return value


def layout(model, data, annual_irradiation):
    length = bounded(data, "length", .2, 8)
    width = bounded(data, "width", .2, 8)
    watts = bounded(data, "watts", 1, 2500)
    spacing = bounded(data, "spacing", 0, 5)
    setback = bounded(data, "setback", 0, 10)
    ratio = bounded(data, "ratio", .01, 1)
    target = bounded(data, "target", 0, 1e9)
    size_to_target = data["mode"] == "target" and target > 0
    selected = list(dict.fromkeys(int(face) for face in data["faces"]))
    if not selected or len(selected) > 50:
        raise ValueError("Select between one and 50 planar roof faces.")
    surfaces = np.asarray(model["patches"])
    normals = np.asarray(model["normals"])
    groups = np.asarray(model["faces"])
    triangle_groups = np.asarray(model["triangleFaces"])
    base_triangles = np.asarray(model["triangles"])
    irradiation = np.asarray(annual_irradiation, dtype=float)
    if irradiation.shape != (len(groups),) or not np.isfinite(irradiation).all() or np.any(irradiation < 0):
        raise ValueError("Run annual analysis for the current site before planning modules.")

    all_modules = []
    occupied = Polygon()
    for face in selected:
        ids = np.flatnonzero(groups == face)
        if len(ids) == 0 or normals[ids[0], 2] <= .25:
            raise ValueError("Select roof surfaces for panel placement.")
        normal = normals[ids[0]]
        origin = surfaces[ids[0], 0]
        roof_triangles = base_triangles[triangle_groups == face]
        if np.max(np.abs((roof_triangles-origin) @ normal)) > .002:
            raise ValueError(f"Face {face+1} is curved. Select planar roof faces.")
        uphill = np.array([0., 0., 1.])-normal*normal[2]
        axis_v = uphill/np.linalg.norm(uphill) if np.linalg.norm(uphill)>1e-6 else np.array([0.,1.,0.])
        axis_u = np.cross(axis_v, normal)
        axes = np.stack((axis_u, axis_v))
        project = lambda points: (points-origin) @ axes.T
        lift = lambda points: np.asarray(points) @ axes + origin
        boundary = union_all([Polygon(coords) for coords in project(roof_triangles)], grid_size=1e-6)
        usable = boundary.buffer(-max(setback, spacing/2), join_style="mitre")
        holes = []
        for item in data.get("exclusions", []):
            if int(item["face"]) != face:
                continue
            points = np.asarray(item["points"], dtype=float)
            if points.ndim != 2 or points.shape[1] != 3 or not 3 <= len(points) <= 100:
                raise ValueError("An exclusion must have 3–100 vertices.")
            if not np.isfinite(points).all() or np.max(np.abs((points-origin) @ normal)) > .01:
                raise ValueError("Each exclusion must lie on its selected roof face.")
            hole = Polygon(project(points))
            if not hole.is_valid or hole.area < .001:
                raise ValueError(f"Face {face+1} has a self-crossing or very small exclusion.")
            holes.append(hole)
        if holes:
            usable = usable.difference(union_all(holes))
        if usable.is_empty:
            continue
        prepare(usable)
        patch_polys = [Polygon(coords) for coords in project(surfaces[ids])]
        tree = STRtree(patch_polys)
        xmin, ymin, xmax, ymax = usable.bounds
        energy_cache = {}
        best = []
        best_score = (-1, -1)
        for w,h in [(width,length),(length,width)]:
            cols = math.ceil((xmax-xmin)/(w+spacing))
            rows = math.ceil((ymax-ymin)/(h+spacing))
            if rows*cols > 20000:
                raise ValueError("Grid is too large. Select smaller roof faces or increase module size.")
            for off_x in (0, 1/3, 2/3):
                for off_y in (0, 1/3, 2/3):
                    choice = []
                    for row in range(rows):
                        for col in range(cols):
                            x = xmin + (col+off_x)*(w+spacing)
                            y = ymin + (row+off_y)*(h+spacing)
                            if x+w > xmax+EPSILON or y+h > ymax+EPSILON:
                                continue
                            footprint = box(x,y,x+w,y+h)
                            if not covers(usable, footprint):
                                continue
                            corners = lift([(x,y),(x+w,y),(x+w,y+h),(x,y+h)])
                            projected = Polygon(corners[:,:2])
                            if not occupied.is_empty and occupied.intersection(projected).area > EPSILON:
                                continue
                            key = (x,y,w,h)
                            if key not in energy_cache:
                                near = tree.query(footprint)
                                weights = np.array([patch_polys[j].intersection(footprint).area for j in near])
                                poa = float(weights @ irradiation[ids[near]] / weights.sum()) if weights.sum() else 0.
                                energy_cache[key] = poa
                            poa = energy_cache[key]
                            choice.append((dict(face=face,corners=corners.round(6).tolist(),poa=poa,
                                                kwh=poa*watts/1000*ratio), projected))
                    generation = sum(module["kwh"] for module,_ in choice)
                    score = (generation,len(choice)) if size_to_target else (len(choice),generation)
                    if score > best_score:
                        best, best_score = choice, score
        if best:
            occupied = union_all([occupied,*[poly for _,poly in best]])
            all_modules.extend(module for module,_ in best)
    maximum = sum(module["kwh"] for module in all_modules)
    if size_to_target and maximum >= target:
        chosen, running = [], 0.
        for module in sorted(all_modules,key=lambda item:item["kwh"],reverse=True):
            chosen.append(module)
            running += module["kwh"]
            if running >= target:
                break
    else:
        chosen = all_modules
    generation = sum(module["kwh"] for module in chosen)
    return dict(modules=chosen,count=len(chosen),kwp=len(chosen)*watts/1000,
                generation=generation,maximum=maximum,target=target if size_to_target else None,
                shortfall=max(0,target-generation) if size_to_target else None,
                watts=watts,ratio=ratio)

