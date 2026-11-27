"""Recalculate the bundled villa and verify two samples on one pitched CAD face."""
import argparse
import json
import time

import numpy as np

from solar import DEFAULT, ROOT, VILLA, Scene, read_step


def verify():
    start = time.perf_counter()
    model = read_step(VILLA)
    scene = Scene(model)
    result = scene.annual(DEFAULT)
    assert result["hours"] == 8784
    normals = scene.normals
    groups = np.array(model["faces"])
    loss, total = np.array(result["loss"]), np.array(result["total"])
    pairs = []
    for face in np.unique(groups):
        ids = np.flatnonzero((groups == face) & (normals[:, 2] > 0.25) & (normals[:, 2] < 0.995))
        if len(ids) < 2:
            continue
        shaded, clear = ids[np.argmax(loss[ids])], ids[np.argmin(loss[ids])]
        if np.allclose(normals[shaded], normals[clear]):
            pairs.append((total[clear] - total[shaded], int(shaded), int(clear)))
    difference, shaded, clear = max(pairs)
    assert difference > 1, "No significant shading difference on a single pitch."
    assert loss[clear] < 0.05, "Comparison point must have negligible direct shading."
    assert abs(result["open"][shaded] - result["open"][clear]) < .03
    for index in (shaded, clear):
        assert abs(total[index] - sum(result[key][index] for key in ("direct", "diffuse", "ground"))) < .03

    def sample(index):
        return {
            "index": index, "patch": index+1, "face": int(groups[index])+1,
            "center_m": scene.centers[index].round(3).tolist(),
            "annual": result["total"][index], "beam_loss": result["loss"][index],
        }

    result["check"] = {
        "shaded": sample(shaded), "clear": sample(clear),
        "tilt": round(float(np.degrees(np.arccos(normals[shaded, 2]))), 2),
        "azimuth": round(float(np.degrees(np.arctan2(*normals[shaded, :2]))) % 360, 2),
        "difference": round(float(difference), 2),
    }
    print(json.dumps(result["check"], indent=2))
    print(f"{result['hours']} hourly records, {len(groups)} patches, {time.perf_counter()-start:.2f} s")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Regenerate bundled villa results.")
    result = verify()
    if parser.parse_args().refresh:
        (ROOT / "data" / "villa-results.json").write_text(json.dumps(result), encoding="utf-8")

