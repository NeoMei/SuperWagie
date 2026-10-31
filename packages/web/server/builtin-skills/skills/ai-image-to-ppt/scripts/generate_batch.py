#!/usr/bin/env python3
"""Bounded parallel API image generation for independent slide targets.

This module intentionally does not own sticky provider routing or SuperPPT
checkpoint writes. The caller must select one provider for the batch and use
one unique output path per item. It is a transport-level accelerator for API
requests; the caller remains responsible for charging and persisting results.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import json
from pathlib import Path
from typing import Any
from typing import Callable, Mapping, Optional, Sequence

from generation_result import GenerationResult, GenerationStatus, safe_message
from gen_slide import generate_result

MAX_BATCH_WORKERS = 4


def _validate_items(items: Sequence[Mapping[str, object]]) -> list[dict[str, object]]:
    if not isinstance(items, (list, tuple)):
        raise ValueError("items must be a list")
    normalized: list[dict[str, object]] = []
    slide_ids: set[str] = set()
    targets: set[str] = set()
    for item in items:
        if not isinstance(item, Mapping):
            raise ValueError("each item must be an object")
        slide_id = item.get("slideId")
        prompt = item.get("prompt")
        out_path = item.get("outPath")
        references = item.get("referenceImages", ())
        if not isinstance(slide_id, str) or not slide_id:
            raise ValueError("slideId must be a non-empty string")
        if not isinstance(prompt, str) or not prompt:
            raise ValueError("prompt must be a non-empty string")
        if not isinstance(out_path, str) or not out_path:
            raise ValueError("outPath must be a non-empty string")
        if not isinstance(references, (list, tuple)) or not all(isinstance(path, str) and path for path in references):
            raise ValueError("referenceImages must contain non-empty paths")
        if slide_id in slide_ids:
            raise ValueError("slideId values must be unique")
        if out_path in targets:
            raise ValueError("outPath values must be unique")
        slide_ids.add(slide_id)
        targets.add(out_path)
        normalized.append({
            "slideId": slide_id,
            "prompt": prompt,
            "outPath": out_path,
            "referenceImages": tuple(references),
        })
    return normalized


def run_batch(
    items: Sequence[Mapping[str, object]],
    *,
    engine: str,
    retries: int = 0,
    max_workers: int = 2,
    generate: Callable[..., GenerationResult] = generate_result,
) -> list[dict[str, object]]:
    """Generate independent pages concurrently and return results in input order."""
    if not isinstance(max_workers, int) or isinstance(max_workers, bool) or not 1 <= max_workers <= MAX_BATCH_WORKERS:
        raise ValueError(f"max_workers must be between 1 and {MAX_BATCH_WORKERS}")
    normalized = _validate_items(items)
    if not normalized:
        return []

    def one(item: dict[str, object]) -> dict[str, object]:
        try:
            kwargs: dict[str, object] = {
                "engine": engine,
                "retries": retries,
                "overwrite": False,
                "progress": None,
            }
            references = item["referenceImages"]
            if references:
                kwargs["reference_images"] = references
            result = generate(str(item["prompt"]), str(item["outPath"]), **kwargs)
            if not isinstance(result, GenerationResult):
                raise TypeError("provider returned an invalid generation result")
        except Exception as error:
            result = GenerationResult(
                GenerationStatus.LOCAL_FAILURE,
                engine,
                "api",
                safe_message(f"batch worker failed: {error}"),
            )
        return {"slideId": item["slideId"], "result": result}

    results: list[Optional[dict[str, object]]] = [None] * len(normalized)
    with ThreadPoolExecutor(max_workers=min(max_workers, len(normalized)), thread_name_prefix="slide-gen") as pool:
        futures = {pool.submit(one, item): index for index, item in enumerate(normalized)}
        for future in as_completed(futures):
            results[futures[future]] = future.result()
    return [result for result in results if result is not None]


def _result_payload(result: GenerationResult) -> dict[str, object]:
    return json.loads(result.to_json())


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate independent slide images with a bounded API worker pool."
    )
    parser.add_argument("manifest", help="JSON file containing {\"pages\": [...]} or a page array")
    parser.add_argument("--engine", choices=("openai", "gemini", "doubao"), required=True)
    parser.add_argument("--workers", type=int, default=2, help="Maximum concurrent requests (1..4, default: 2)")
    parser.add_argument("--retries", type=int, default=0, help="Per-request retries; 0 keeps batch accounting exact")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        pages: Any = manifest.get("pages") if isinstance(manifest, dict) else manifest
        results = run_batch(pages, engine=args.engine, retries=args.retries, max_workers=args.workers)
        payload = {
            "engine": args.engine,
            "workers": args.workers,
            "pages": [
                {"slideId": result["slideId"], "result": _result_payload(result["result"])}
                for result in results
            ],
        }
        print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
        return 0 if all(result["result"].ok for result in results) else 1
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["MAX_BATCH_WORKERS", "main", "run_batch"]
