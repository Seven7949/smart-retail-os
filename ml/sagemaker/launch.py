"""Launch the SageMaker training job (used by .github/workflows/train-sagemaker.yml).

    python ml/sagemaker/launch.py --role <SageMakerRoleArn> --bucket <ArtifactBucket>

Uses the managed scikit-learn container + script mode, on a small spot
instance to keep cost to a few rupees per run.
"""
from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def build_source_dir() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="sros-sm-"))
    shutil.copytree(ROOT / "ml" / "sros_ml", tmp / "sros_ml")
    shutil.copytree(ROOT / "spec", tmp / "spec")
    shutil.copy(ROOT / "ml" / "sagemaker" / "train.py", tmp / "train.py")
    (tmp / "requirements.txt").write_text("lightgbm>=4.0\n")
    return tmp


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", required=True)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--instance-type", default="ml.m5.large")
    ap.add_argument("--framework-version", default="1.2-1")
    ap.add_argument("--wait", action="store_true")
    args = ap.parse_args()

    from sagemaker.sklearn.estimator import SKLearn

    est = SKLearn(
        entry_point="train.py", source_dir=str(build_source_dir()), role=args.role,
        framework_version=args.framework_version, py_version="py3", instance_type=args.instance_type,
        instance_count=1, use_spot_instances=True, max_run=1800, max_wait=3600,
        output_path=f"s3://{args.bucket}/sagemaker/models", code_location=f"s3://{args.bucket}/sagemaker/code",
        environment={"SROS_SPEC_DIR": "/opt/ml/code/spec"},
        metric_definitions=[{"Name": "test:wape", "Regex": "test_wape=([0-9.]+)"},
                            {"Name": "baseline:wape", "Regex": "baseline_wape=([0-9.]+)"}],
        base_job_name="sros-demand",
    )
    est.fit(wait=args.wait, logs=args.wait)
    print("Training job:", est.latest_training_job.name)


if __name__ == "__main__":
    main()
