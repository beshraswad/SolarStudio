"""Validate the five-page report against the known villa CSV exports."""
import argparse
from datetime import datetime
from hashlib import sha256
from pathlib import Path

import numpy as np
import pandas as pd
from figure_report import face_table, generate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--annual", type=Path, nargs="+", required=True)
    parser.add_argument("--surfaces", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    unique = {sha256(path.read_bytes()).hexdigest():path for path in args.annual}
    if len(unique)!=1:
        parser.error("Use one annual export, optionally with identical copies.")
    annual = pd.read_csv(next(iter(unique.values())))
    selected, patch = pd.read_csv(args.surfaces), pd.read_csv(args.patch)
    faces = face_table(annual).set_index("face_id")
    for surface, expected in (("roof",1749.70),("wall",910.87)):
        group=faces[faces.surface==surface]
        mean=group.modeled.sum()/group.area_m2.sum()
        assert abs(mean-expected)<.015
        print(surface,round(mean,2))
    assert abs(faces.loc[15,"mean"]-1947.54)<.015
    assert abs(faces.loc[8,"loss"]-39.48)<.015
    max_loss=annual.loc[annual.face_id==8,"total_loss_pct"].max()
    assert abs(max_loss-63.21)<.015
    summaries=selected.groupby("scenario").incident_kWh_per_hour.sum()/1000
    assert np.allclose(summaries,1685.80,atol=.02)
    paired=selected.pivot(index=["face_id","timestamp_midpoint"],columns="scenario",values="incident_kWh_per_hour")
    assert paired.shape[1]==2 and np.allclose(paired.iloc[:,0],paired.iloc[:,1])
    assert selected.groupby(["scenario","face_id"]).size().eq(8784).all()
    assert len(patch)==8784 and abs(patch.poa_wh_m2.sum()/1000-1128.38)<.015
    assert patch.direct_sun.sum()==3278 and abs(patch.beam_loss_wh_m2.sum())<.001
    print("South face 15, flat roof loss, 11 selected faces, and patch 1 verified.")
    meta=annual.iloc[0]
    config=dict(year=int(meta.year_utc),lat=meta.latitude_deg,lon=meta.longitude_deg,north=meta.north_model_deg)
    tz=datetime.strptime(selected.utc_offset.iloc[0],"%z").tzinfo
    project=selected.project.iloc[0]
    pdf,figures=generate(project,config,tz,annual,selected,patch)
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output/"report.pdf").write_bytes(pdf)
    for i,image in enumerate(figures,1):
        (args.output/f"figure-{i}.png").write_bytes(image)
    assert len(figures)==10
    # A different baseline must produce a visibly different average-day chart.
    different=selected.copy()
    different.loc[different.scenario=="targets only","incident_kWh_per_hour"]*=1.1
    _,different_figures=generate(project,config,tz,annual,different,patch)
    assert different_figures[7]!=figures[7]
    print("Generated 10 PNGs and a landscape PDF. The differing comparison changes Figure 8.")


if __name__=="__main__":
    main()

