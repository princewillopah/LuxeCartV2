#!/usr/bin/env python3
"""Compute the CI build matrix from .github/services.json + the git diff.

Outputs (to $GITHUB_OUTPUT):
  matrix : JSON {"include": [<service objects>]} for strategy.matrix
  any    : "true" if at least one service must build, else "false"

Selection rules:
  * workflow_dispatch, first push, or unknown base  -> build everything
  * any change under .github/workflows|scripts or services.json -> build everything
  * change under app/backend-services/shared/ -> rebuild every node + python service
  * otherwise -> rebuild only services whose `path` contains a changed file
"""
import json
import os
import subprocess

ZERO = "0" * 40


def emit(key: str, value: str) -> None:
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
        fh.write(f"{key}={value}\n")


def main() -> None:
    base = os.environ.get("BASE", "").strip()
    head = os.environ.get("HEAD", "").strip() or "HEAD"
    event = os.environ.get("EVENT", "")

    services = json.load(open(".github/services.json", encoding="utf-8"))["services"]

    build_all = False
    changed: list[str] = []

    if event == "workflow_dispatch" or not base or base == ZERO:
        build_all = True
    else:
        try:
            diff = subprocess.run(
                ["git", "diff", "--name-only", base, head],
                capture_output=True, text=True, check=True,
            ).stdout
            changed = [line for line in diff.splitlines() if line.strip()]
        except subprocess.CalledProcessError:
            build_all = True

    if any(
        c.startswith(".github/workflows/")
        or c.startswith(".github/scripts/")
        or c == ".github/services.json"
        for c in changed
    ):
        build_all = True

    shared_changed = any(c.startswith("app/backend-services/shared/") for c in changed)

    selected = []
    for svc in services:
        path = svc["path"]
        if build_all:
            selected.append(svc)
            continue
        hit = any(c == path or c.startswith(path + "/") for c in changed)
        if not hit and shared_changed and svc["lang"] in ("node", "python"):
            hit = True
        if hit:
            selected.append(svc)

    emit("matrix", json.dumps({"include": selected}))
    emit("any", "true" if selected else "false")
    print(f"build_all={build_all} shared_changed={shared_changed} "
          f"selected={[s['name'] for s in selected]}")


if __name__ == "__main__":
    main()
