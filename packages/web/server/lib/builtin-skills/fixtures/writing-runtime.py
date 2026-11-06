"""Exercise an installed SuperWriter copy with synthetic project evidence only."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))

from collaboration.model import apply_event, initial_state
from tender_template import TemplateError, copy_template, resolve_template
from verify_acceptance import (
    validate_pipeline_v1,
    validate_pipeline_v2,
    verify_tender_template,
)


def write(root, relative, content):
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = content.encode("utf-8")
    target.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def rejected(action, message):
    output = io.StringIO()
    with contextlib.redirect_stderr(output):
        try:
            action()
        except SystemExit as error:
            assert error.code == 1
        else:
            raise AssertionError("invalid project was accepted")
    assert message in output.getvalue(), output.getvalue()


def current_project(root):
    state = initial_state("synthetic-bundle-validation")
    objects = [
        ("approach", "approach", "写作共识.md", {}, {"material_resolutions": {}}),
        ("outline", "outline", "大纲.md", {"approach": 1}, {"chapter_order": ["chapter"]}),
        ("chapter", "chapter", "章节/01.md", {"approach": 1, "outline": 1}, {"required_material_ids": []}),
        ("figures", "figure_set", "配图/无图决定.md", {"chapter": 1}, {"figure_ids": [], "mode": "none"}),
        ("manuscript", "manuscript", "合并稿.md", {"chapter": 1, "figures": 1}, {}),
    ]
    for object_id, kind, relative, dependencies, metadata in objects:
        digest = write(root, relative, "# Synthetic fixture\n\nControlled project evidence.\n")
        state["objects"][object_id] = {
            "id": object_id, "kind": kind, "path": relative, "version": 1,
            "sha256": digest, "dependencies": dependencies,
            "status": "pending_review", "metadata": metadata,
        }
        state["active_object_id"] = object_id
        state = apply_event(state, {
            "id": "approve-" + object_id, "kind": "approve", "object_id": object_id,
            "version": 1, "sha256": digest, "channel": "chat", "payload": {},
            "evidence": {"reference": "synthetic-test-only", "text": "Synthetic fixture approval"},
        })
    state["objects"]["delivery"] = {
        "id": "delivery", "kind": "delivery", "path": "交付/报告.md", "version": 1,
        "sha256": write(root, "交付/报告.md", "Synthetic report\n"),
        "dependencies": {"manuscript": 1}, "status": "draft", "metadata": {},
    }
    state["active_object_id"] = "delivery"
    state["stage"] = "delivery"
    for relative in ["评分表解析.md", "应答矩阵.md"]:
        write(root, relative, "Synthetic evidence\n")
    state_path = root / "协作状态.json"
    state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    pipeline = {
        "workflow_version": 2, "state": "协作状态.json",
        "state_revision": state["revision"], "manuscript_object_id": "manuscript",
    }
    before = state_path.read_bytes()
    assert validate_pipeline_v2(root, pipeline)["version"] == 2
    assert state_path.read_bytes() == before
    rejected(lambda: validate_pipeline_v2(root, {**pipeline, "state_revision": 0}), "revision differs")
    state["objects"]["chapter"]["status"] = "pending_review"
    state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    rejected(lambda: validate_pipeline_v2(root, pipeline), "chapter must be approved")


def legacy_project(root):
    for relative in ["评分表解析.md", "应答矩阵.md", "大纲.md"]:
        write(root, relative, "Synthetic legacy evidence\n")
    write(root, "流水线状态.md", "当前阶段：9 完成\n流程门：0 2 3 5 6 7 8\n人工介入：3 次\n")
    evidence = []
    for stage in range(10):
        relative = f"evidence/{stage}.md"
        write(root, relative, f"Synthetic stage {stage}\n")
        evidence.append({"stage": stage, "path": relative})
    pipeline = {
        "status": "流水线状态.md", "score_table": "评分表解析.md", "matrix": "应答矩阵.md",
        "outline": "大纲.md", "completed_stage": 9, "human_gates": [2, 5, 8],
        "machine_gates": [0, 3, 6, 7], "stage_evidence": evidence,
    }
    assert validate_pipeline_v1(root, pipeline)["version"] == 1
    rejected(lambda: validate_pipeline_v1(root, {**pipeline, "human_gates": [2, 5]}), "gate contract")
    (root / "evidence/9.md").unlink()
    rejected(lambda: validate_pipeline_v1(root, pipeline), "missing for stage 9")


def template_project(root):
    template = root / "模板.docx"
    with zipfile.ZipFile(template, "w") as archive:
        archive.writestr("word/styles.xml", b"original style")
        archive.writestr("word/document.xml", b"controlled content")
    spec = {"mode": "copy", "path": "模板.docx", "format": "docx", "sha256": hashlib.sha256(template.read_bytes()).hexdigest()}
    output = copy_template(root, spec, Path("交付/输出.docx"))
    assert resolve_template(root, spec).resolve() == template.resolve()
    verify_tender_template(root, output, spec)
    verify_tender_template(root, output, {"mode": "none", "reason": "Verified no supplied template"})
    try:
        resolve_template(root, {**spec, "sha256": "0" * 64})
    except TemplateError as error:
        assert "sha256 differs" in str(error)
    else:
        raise AssertionError("template digest drift was accepted")
    try:
        resolve_template(root, {**spec, "path": "../outside.docx"})
    except TemplateError as error:
        assert "project-relative" in str(error)
    else:
        raise AssertionError("template traversal was accepted")
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("word/styles.xml", b"changed style")
    rejected(lambda: verify_tender_template(root, output, spec), "stable template part differs")


with tempfile.TemporaryDirectory(prefix="writing-controlled-") as temporary:
    root = Path(temporary)
    for name, check in [("current", current_project), ("legacy", legacy_project), ("template", template_project)]:
        project = root / name
        project.mkdir()
        check(project)
        print(f"PASS {name}")
