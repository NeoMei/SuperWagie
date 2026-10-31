import threading
import time
import unittest
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT / "scripts"))

from generation_result import GenerationResult, GenerationStatus
import generate_batch


class BatchGenerationTests(unittest.TestCase):
    def test_runs_unique_pages_concurrently_with_a_bounded_worker_pool(self):
        entered = threading.Event()
        release = threading.Event()
        active = 0
        max_active = 0
        lock = threading.Lock()

        def fake_generate(prompt, out_path, **kwargs):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
                if active == 2:
                    entered.set()
            self.assertTrue(entered.wait(2))
            self.assertTrue(release.wait(2))
            with lock:
                active -= 1
            return GenerationResult(
                GenerationStatus.SUCCESS,
                "openai",
                "api",
                output_path=out_path,
            )

        items = [
            {"slideId": f"slide-{index}", "prompt": f"prompt-{index}", "outPath": str((ROOT / "test-output" / f"slide-{index}.png").resolve())}
            for index in range(3)
        ]

        results = []

        def run():
            results.extend(generate_batch.run_batch(items, engine="openai", max_workers=2, generate=fake_generate))

        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(2), "the worker pool did not start two pages")
        time.sleep(0.05)
        self.assertEqual(max_active, 2)
        release.set()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual([result["slideId"] for result in results], ["slide-0", "slide-1", "slide-2"])

    def test_rejects_invalid_worker_limits_before_starting_requests(self):
        generate = lambda *args, **kwargs: self.fail("request should not start")
        with self.assertRaises(ValueError):
            generate_batch.run_batch([], engine="openai", max_workers=0, generate=generate)
        with self.assertRaises(ValueError):
            generate_batch.run_batch([], engine="openai", max_workers=5, generate=generate)

    def test_cli_emits_ordered_json_results(self):
        manifest = ROOT / "test-output" / "batch-manifest-test.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"pages": [{"slideId": "slide-1", "prompt": "p", "outPath": "/tmp/slide-1.png"}]}))
        result = GenerationResult(
            GenerationStatus.SUCCESS,
            "openai",
            "api",
            output_path="/tmp/slide-1.png",
        )
        stdout = io.StringIO()
        try:
            with mock.patch.object(generate_batch, "run_batch", return_value=[{"slideId": "slide-1", "result": result}]), redirect_stdout(stdout):
                self.assertEqual(generate_batch.main([str(manifest), "--engine", "openai", "--workers", "2"]), 0)
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["pages"][0]["slideId"], "slide-1")
            self.assertEqual(payload["pages"][0]["result"]["status"], "success")
        finally:
            manifest.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
