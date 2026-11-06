import importlib.util
import itertools
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[3] / "builtin-skills" / "skills" / "obsidian-excalidraw"
MODULE_PATH = REPO_ROOT / "references" / "generate.py"
MODULE_SPEC = importlib.util.spec_from_file_location("generate", MODULE_PATH)
generate = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(generate)


SCENE_SPEC = {
    "title": "Overall title",
    "notes": [{"x": 20, "y": 20, "text": "Free note"}],
    "groups": [{"id": "group-a", "label": "Group title", "role": "client"}],
    "nodes": [
        {"id": "first-node", "label": "First\nshape", "group": "group-a"},
        {"id": "second-node", "label": "Second shape", "group": "group-a"},
    ],
    "edges": [
        {"from": "first-node", "to": "second-node", "label": "flows to"},
    ],
}


def text_elements(scene):
    return [element for element in scene["elements"] if element["type"] == "text"]


class ObsidianTextElementIdTests(unittest.TestCase):
    def test_every_text_element_id_is_exactly_eight_alphanumeric_characters(self):
        ids = [element["id"] for element in text_elements(generate.build(SCENE_SPEC))]

        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(
            all(re.fullmatch(r"[A-Za-z0-9]{8}", element_id) for element_id in ids),
            ids,
        )

    def test_markdown_block_references_match_scene_text_ids(self):
        scene = generate.build(SCENE_SPEC)
        expected_ids = [element["id"] for element in text_elements(scene)]

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            generate.to_obsidian_md(scene, output_path)
            markdown = output_path.read_text(encoding="utf-8")

        text_section = markdown.split("## Text Elements\n", 1)[1].split("\n%%", 1)[0]
        parsed_ids = re.findall(r"\s\^(.{8})[\n]+", text_section)

        self.assertEqual(parsed_ids, expected_ids)

    def test_markdown_preserves_multiline_text_verbatim(self):
        scene = generate.build(SCENE_SPEC)
        first_label = next(
            element for element in text_elements(scene)
            if element["containerId"] == "first-node"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            generate.to_obsidian_md(scene, output_path)
            markdown = output_path.read_text(encoding="utf-8")

        self.assertIn(f"First\nshape ^{first_label['id']}", markdown)
        self.assertIn("# Excalidraw Data\n\n## Text Elements\nOverall title", markdown)

    def test_text_ids_do_not_collide_with_non_text_element_ids(self):
        title_hash = "aaf23206"
        spec = {
            "title": "Title",
            "nodes": [{"id": title_hash, "label": "Node"}],
            "edges": [],
        }

        ids = [element["id"] for element in generate.build(spec)["elements"]]

        self.assertEqual(len(ids), len(set(ids)))

    def test_markdown_rejects_text_that_contains_an_internal_block_delimiter(self):
        scene = generate.build(SCENE_SPEC)
        first_label = next(
            element for element in text_elements(scene)
            if element["containerId"] == "first-node"
        )
        first_label["text"] = "before ^12345678\nafter"
        first_label["originalText"] = first_label["text"]

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "block-reference delimiter"):
                generate.to_obsidian_md(scene, output_path)

    def test_markdown_rejects_utf16_sized_block_delimiters_like_javascript(self):
        titles = (
            "before ^" + "😀" * 4 + "\nafter",
            "before\ufeff^12345678\nafter",
        )
        for title in titles:
            with self.subTest(title=title), tempfile.TemporaryDirectory() as tmpdir:
                scene = generate.build({"title": title, "nodes": []})
                output_path = Path(tmpdir) / "scene.excalidraw.md"
                with self.assertRaisesRegex(ValueError, "block-reference delimiter"):
                    generate.to_obsidian_md(scene, output_path)
                self.assertFalse(output_path.exists())

    def test_markdown_rejects_internal_drawing_headings_that_confuse_the_parser(self):
        scene = generate.build({
            "title": "before\n## Drawing\nafter",
            "nodes": [{"id": "first", "label": "node label"}],
            "edges": [],
        })

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "Drawing heading"):
                generate.to_obsidian_md(scene, output_path)
            self.assertFalse(output_path.exists())

    def test_markdown_rejects_internal_metadata_section_headings(self):
        for heading, prefix in (
            ("## Element Links", ""),
            ("# Element Links", "prefix "),
            ("## Embedded Files", "prefix "),
            ("# Embedded files", "prefix "),
        ):
            with self.subTest(heading=heading, prefix=prefix):
                scene = generate.build({
                    "title": f"before\n{prefix}{heading}\n12345678: injected\nafter",
                    "nodes": [{"id": "first", "label": "node label"}],
                    "edges": [],
                })

                with tempfile.TemporaryDirectory() as tmpdir:
                    output_path = Path(tmpdir) / "scene.excalidraw.md"
                    with self.assertRaisesRegex(ValueError, "reserved Obsidian metadata"):
                        generate.to_obsidian_md(scene, output_path)
                    self.assertFalse(output_path.exists())

    def test_markdown_rejects_lines_that_the_plugin_treats_as_element_links(self):
        scene = generate.build({
            "title": "xxxxxxxx: harmless\nnode0001: unintended link",
            "nodes": [{"id": "node0001", "label": "node label"}],
            "edges": [],
        })

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "element-link record"):
                generate.to_obsidian_md(scene, output_path)
            self.assertFalse(output_path.exists())

    def test_markdown_matches_javascript_utf16_and_line_separator_link_records(self):
        cases = (
            {
                "title": "😀" * 4 + ": injected",
                "nodes": [{"id": "😀" * 4, "label": "shape"}],
            },
            {
                "title": "prefix\u2028abcdefgh: injected",
                "nodes": [{"id": "abcdefgh", "label": "shape"}],
            },
        )

        for spec in cases:
            with self.subTest(spec=spec), tempfile.TemporaryDirectory() as tmpdir:
                output_path = Path(tmpdir) / "scene.excalidraw.md"
                with self.assertRaisesRegex(ValueError, "element-link record"):
                    generate.to_obsidian_md(generate.build(spec), output_path)
                self.assertFalse(output_path.exists())

    def test_markdown_rejects_link_record_created_by_the_plugin_offset_bug(self):
        scene = generate.build({
            "title": "123456789012345abcdefgh: https://evil.example",
            "nodes": [{"id": "abcdefgh", "label": "shape"}],
        })

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "element-link record"):
                generate.to_obsidian_md(scene, output_path)
            self.assertFalse(output_path.exists())

    def test_markdown_rejects_non_utf8_text_in_an_external_scene_before_writing(self):
        scene = generate.build({"nodes": []})
        scene["elements"] = [{
            "id": "12345678",
            "type": "text",
            "text": "\ud800",
            "originalText": "\ud800",
        }]

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "valid UTF-8"):
                generate.to_obsidian_md(scene, output_path)
            self.assertFalse(output_path.exists())

    def test_markdown_rejects_non_finite_json_in_an_external_scene_before_writing(self):
        scene = generate.build({"nodes": []})
        scene["elements"] = [{
            "id": "12345678",
            "type": "text",
            "text": "ok",
            "originalText": "ok",
            "x": math.nan,
        }]

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "finite JSON numbers"):
                generate.to_obsidian_md(scene, output_path)
            self.assertFalse(output_path.exists())

    def test_markdown_rejects_compressed_json_fences_inside_text(self):
        scene = generate.build({
            "title": "before\n```compressed-json\nnot scene data\n```\nafter",
            "nodes": [{"id": "first", "label": "node label"}],
            "edges": [],
        })

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "compressed-json"):
                generate.to_obsidian_md(scene, output_path)
            self.assertFalse(output_path.exists())

    def test_markdown_uses_original_text_when_it_differs_from_wrapped_text(self):
        scene = generate.build(SCENE_SPEC)
        first_label = next(
            element for element in text_elements(scene)
            if element["containerId"] == "first-node"
        )
        first_label["text"] = "wrapped\ntext"
        first_label["originalText"] = "original text"

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            generate.to_obsidian_md(scene, output_path)
            markdown = output_path.read_text(encoding="utf-8")

        self.assertIn(f"original text ^{first_label['id']}", markdown)

    def test_markdown_rejects_non_ascii_text_element_ids(self):
        scene = generate.build(SCENE_SPEC)
        text_elements(scene)[0]["id"] = "中文字符一二三四"

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "scene.excalidraw.md"
            with self.assertRaisesRegex(ValueError, "8 alphanumeric"):
                generate.to_obsidian_md(scene, output_path)

    def test_markdown_rejects_duplicate_scene_ids_and_non_string_text(self):
        base_scene = generate.build({"nodes": [{"id": "n", "label": "Node"}]})
        cases = []

        duplicate_text = json.loads(json.dumps(base_scene))
        duplicate_text["elements"].append(dict(text_elements(duplicate_text)[0]))
        cases.append((duplicate_text, "duplicate element id"))

        text_shape_collision = json.loads(json.dumps(base_scene))
        text_elements(text_shape_collision)[0]["id"] = "n"
        cases.append((text_shape_collision, "duplicate element id"))

        non_string_text = json.loads(json.dumps(base_scene))
        text_elements(non_string_text)[0]["originalText"] = 123
        cases.append((non_string_text, "must be a string"))

        for scene, message in cases:
            with (
                self.subTest(message=message),
                tempfile.TemporaryDirectory() as tmpdir,
                self.assertRaisesRegex(ValueError, message),
            ):
                generate.to_obsidian_md(scene, Path(tmpdir) / "scene.excalidraw.md")


class CurrentExcalidrawGrammarTests(unittest.TestCase):
    def test_dense_group_chain_uses_grid_fallback_instead_of_rejecting(self):
        scene = generate.build({
            "groups": [
                {"id": group_id, "label": f"Group {group_id}"}
                for group_id in ("g0", "g1", "g2")
            ],
            "nodes": [
                {"id": "n0"},
                {"id": "n1", "group": "g0"},
                {"id": "n2", "group": "g2"},
                {"id": "n3", "group": "g1"},
                {"id": "n4", "group": "g2"},
            ],
            "edges": [
                {"from": "n0", "to": "n1"},
                {"from": "n1", "to": "n2"},
                {"from": "n2", "to": "n3"},
                {"from": "n3", "to": "n4"},
            ],
        })

        self.assertEqual(
            len([element for element in scene["elements"] if element["type"] == "arrow"]),
            4,
        )

    def test_grid_fallback_takes_a_longer_outer_route_when_a_label_needs_room(self):
        scene = generate.build({
            "nodes": [
                {"id": "n0", "label": "n0", "group": "g2"},
                {"id": "n1", "label": "n1", "group": "g0"},
                {"id": "n2", "label": "n2", "group": "g2"},
                {"id": "n3", "label": "n3"},
                {"id": "n5", "label": "n5", "group": "g2"},
            ],
            "edges": [{"from": "n5", "to": "n0", "label": "x"}],
            "groups": [
                {"id": "g0", "label": "Group 0"},
                {"id": "g2", "label": "Group 2"},
            ],
            "direction": "TB",
        })
        arrow = next(element for element in scene["elements"] if element["id"] == "arr-0")
        label = next(
            element for element in scene["elements"]
            if element.get("containerId") == "arr-0"
        )
        points = [(arrow["x"] + x, arrow["y"] + y) for x, y in arrow["points"]]

        self.assertEqual(
            (label["x"] + label["width"]/2, label["y"] + label["height"]/2),
            generate._bound_text_anchor(points),
        )

    def test_bound_label_routing_never_emits_adjacent_duplicate_points(self):
        scene = generate.build({
            "nodes": [
                {"id": "a", "label": "x"},
                {"id": "b", "label": "wide label wide label"},
                {"id": "c", "label": "x"},
            ],
            "edges": [
                {"from": "a", "to": "c"},
                {"from": "b", "to": "a"},
                {"from": "c", "to": "b", "label": "x"},
            ],
            "direction": "LR",
        })
        arrow = next(element for element in scene["elements"] if element["id"] == "arr-2")

        self.assertTrue(all(
            first != second
            for first, second in generate._pairwise(arrow["points"])
        ))

    def test_multiple_feedback_edges_use_distinct_outer_lanes(self):
        scene = generate.build({
            "nodes": [{"id": node_id} for node_id in ("a", "b", "c", "d")],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "c", "to": "d"},
                {"from": "c", "to": "a", "label": "C-A"},
                {"from": "d", "to": "a", "label": "D-A"},
            ],
        })
        by_id = {element["id"]: element for element in scene["elements"]}
        feedback_paths = []
        for arrow_id in ("arr-3", "arr-4"):
            arrow = by_id[arrow_id]
            feedback_paths.append([
                (arrow["x"] + x, arrow["y"] + y) for x, y in arrow["points"]
            ])

        self.assertNotEqual(feedback_paths[0], feedback_paths[1])
        self.assertNotEqual(
            min(x for x, _ in feedback_paths[0]),
            min(x for x, _ in feedback_paths[1]),
        )

    def test_edge_labels_do_not_overlap_each_other(self):
        scene = generate.build({
            "nodes": [{"id": f"n{index}"} for index in range(4)],
            "edges": [
                {"from": "n0", "to": "n2", "label": "A"},
                {"from": "n3", "to": "n1", "label": "B"},
            ],
            "direction": "TB",
        })
        labels = [
            element for element in scene["elements"]
            if isinstance(element.get("containerId"), str)
            and element["containerId"].startswith("arr-")
        ]
        boxes = [
            (label["x"], label["y"], label["width"], label["height"])
            for label in labels
        ]

        self.assertEqual(len(boxes), 2)
        self.assertFalse(generate._boxes_intersect(*boxes), boxes)

    def test_lr_cycle_route_and_label_avoid_the_overall_title(self):
        scene = generate.build({
            "title": "W" * 60,
            "direction": "LR",
            "nodes": [{"id": node_id} for node_id in ("a", "b", "c")],
            "edges": [
                {"from": "a", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "c", "to": "a", "label": "cycle"},
            ],
        })
        title = next(
            element for element in scene["elements"]
            if element.get("originalText") == "W" * 60
        )
        arrow = next(element for element in scene["elements"] if element["id"] == "arr-2")
        label = next(
            element for element in scene["elements"]
            if element.get("containerId") == "arr-2"
        )
        points = [
            (arrow["x"] + x, arrow["y"] + y) for x, y in arrow["points"]
        ]
        title_box = (title["x"], title["y"], title["width"], title["height"])

        self.assertTrue(all(
            not generate._segment_crosses_box(start, end, title_box, 0)
            for start, end in zip(points, points[1:])  # noqa: RUF007
        ))
        self.assertTrue(
            label["x"] + label["width"] <= title["x"]
            or title["x"] + title["width"] <= label["x"]
            or label["y"] + label["height"] <= title["y"]
            or title["y"] + title["height"] <= label["y"]
        )

    def test_cross_layer_and_cycle_arrows_route_around_intermediate_nodes(self):
        cases = (
            ({}, {"from": "a", "to": "c"}),
            ({}, {"from": "c", "to": "a"}),
            ({"direction": "LR"}, {"from": "a", "to": "c"}),
            ({"groups": [{"id": node_id} for node_id in ("ga", "gb", "gc")]}, {"from": "a", "to": "c"}),
        )
        for options, long_edge in cases:
            with self.subTest(options=options, long_edge=long_edge):
                nodes = [{"id": node_id} for node_id in ("a", "b", "c")]
                if options.get("groups"):
                    for node, group in zip(nodes, options["groups"]):
                        node["group"] = group["id"]
                scene = generate.build({
                    **options,
                    "nodes": nodes,
                    "edges": [
                        {"from": "a", "to": "b"},
                        {"from": "b", "to": "c"},
                        {**long_edge, "label": "bypass"},
                    ],
                })
                by_id = {element["id"]: element for element in scene["elements"]}
                arrow = by_id["arr-2"]
                blocker = by_id["b"]
                points = [
                    (arrow["x"] + point[0], arrow["y"] + point[1])
                    for point in arrow["points"]
                ]

                self.assertGreater(len(points), 2)
                left, top = blocker["x"] + 1, blocker["y"] + 1
                right = blocker["x"] + blocker["width"] - 1
                bottom = blocker["y"] + blocker["height"] - 1
                for start, end in zip(points, points[1:]):  # noqa: RUF007
                    for step in range(101):
                        fraction = step / 100
                        x = start[0] + (end[0] - start[0]) * fraction
                        y = start[1] + (end[1] - start[1]) * fraction
                        self.assertFalse(
                            left < x < right and top < y < bottom,
                            (points, blocker),
                        )
                label = next(
                    element for element in scene["elements"]
                    if element.get("containerId") == "arr-2"
                )
                expected_label_center = generate._bound_text_anchor(points)
                self.assertEqual(
                    (label["x"] + label["width"]/2, label["y"] + label["height"]/2),
                    expected_label_center,
                )
                self.assertTrue(
                    label["x"] + label["width"] <= blocker["x"]
                    or blocker["x"] + blocker["width"] <= label["x"]
                    or label["y"] + label["height"] <= blocker["y"]
                    or blocker["y"] + blocker["height"] <= label["y"],
                    (label, blocker),
                )

    def test_elements_emit_current_base_and_text_defaults(self):
        scene = generate.build(SCENE_SPEC)

        self.assertTrue(all("index" in element for element in scene["elements"]))
        self.assertTrue(all(element["autoResize"] is True for element in text_elements(scene)))
        self.assertTrue(all(element["roundness"] is None for element in text_elements(scene)))

    def test_arrows_use_fixed_point_bindings_and_persist_elbowed_false(self):
        arrow = next(
            element for element in generate.build(SCENE_SPEC)["elements"]
            if element["type"] == "arrow"
        )

        self.assertEqual(
            arrow["startBinding"],
            {"elementId": "first-node", "fixedPoint": [0.5, 1.0], "mode": "orbit"},
        )
        self.assertEqual(
            arrow["endBinding"],
            {"elementId": "second-node", "fixedPoint": [0.5, 0.0], "mode": "orbit"},
        )
        self.assertIs(arrow["elbowed"], False)
        self.assertNotIn("lastCommittedPoint", arrow)
        self.assertEqual(arrow["width"], 0)
        self.assertEqual(arrow["height"], 40)

    def test_cardinality_arrowheads_use_renderer_compatible_names(self):
        aliases = {
            "dot": "dot",
            "crowfoot_one": "crowfoot_one",
            "crowfoot_many": "crowfoot_many",
            "crowfoot_one_or_many": "crowfoot_one_or_many",
            "cardinality_one": "crowfoot_one",
            "cardinality_many": "crowfoot_many",
            "cardinality_one_or_many": "crowfoot_one_or_many",
        }

        for legacy, current in aliases.items():
            spec = dict(SCENE_SPEC)
            spec["edges"] = [
                {"from": "first-node", "to": "second-node", "arrowhead": legacy},
            ]
            arrow = next(
                element for element in generate.build(spec)["elements"]
                if element["type"] == "arrow"
            )
            self.assertEqual(arrow["endArrowhead"], current)

        for unsupported in (
            "cardinality_exactly_one",
            "cardinality_zero_or_one",
            "cardinality_zero_or_many",
        ):
            spec = dict(SCENE_SPEC)
            spec["edges"] = [
                {"from": "first-node", "to": "second-node", "arrowhead": unsupported},
            ]
            with self.assertRaisesRegex(ValueError, "vendored renderer"):
                generate.build(spec)


class TextLayoutTests(unittest.TestCase):
    @staticmethod
    def assert_boxes_do_not_intersect(first, second):
        separated = (
            first["x"] + first["width"] <= second["x"]
            or second["x"] + second["width"] <= first["x"]
            or first["y"] + first["height"] <= second["y"]
            or second["y"] + second["height"] <= first["y"]
        )
        if not separated:
            raise AssertionError(f"boxes intersect: {first} vs {second}")

    def test_multiline_node_text_stays_inside_its_node_and_layers_do_not_overlap(self):
        spec = {
            "nodes": [
                {"id": "top", "label": "一\n二\n三\n四\n五"},
                {"id": "bottom", "label": "下一层"},
            ],
            "edges": [{"from": "top", "to": "bottom"}],
        }

        scene = generate.build(spec)
        top = next(element for element in scene["elements"] if element["id"] == "top")
        bottom = next(element for element in scene["elements"] if element["id"] == "bottom")
        label = next(
            element for element in text_elements(scene)
            if element["containerId"] == "top"
        )

        self.assertGreaterEqual(label["y"], top["y"])
        self.assertLessEqual(label["y"] + label["height"], top["y"] + top["height"])
        self.assertGreater(bottom["y"], top["y"] + top["height"])

    def test_multiline_notes_and_titles_have_sufficient_height(self):
        scene = generate.build({
            "title": "第一行\n第二行",
            "notes": [{"x": 10, "y": 200, "text": "一\n二\n三"}],
            "nodes": [{"id": "node", "label": "节点"}],
            "edges": [],
        })
        free_text = [
            element for element in text_elements(scene)
            if element["containerId"] is None
        ]
        title = next(element for element in free_text if element["fontSize"] == 34)
        note = next(element for element in free_text if element["fontSize"] == 14)
        node = next(element for element in scene["elements"] if element["id"] == "node")

        self.assertGreaterEqual(title["height"], 2 * title["fontSize"] * title["lineHeight"])
        self.assertGreaterEqual(note["height"], 3 * note["fontSize"] * note["lineHeight"])
        self.assertGreater(node["y"], title["y"] + title["height"])

    def test_long_titles_and_notes_expand_instead_of_clipping(self):
        title_text = "超长总标题" * 25
        note_text = "long annotation " * 30
        scene = generate.build({
            "title": title_text,
            "notes": [{"x": 20, "y": 500, "text": note_text, "w": 80, "h": 1}],
            "nodes": [],
            "edges": [],
        })
        title = next(
            element for element in text_elements(scene)
            if element["text"] == title_text
        )
        note = next(
            element for element in text_elements(scene)
            if element["text"] == note_text
        )

        self.assertGreaterEqual(
            title["width"],
            generate.T.text_width(title_text, generate.T.FONT_TITLE),
        )
        self.assertGreaterEqual(
            note["width"],
            generate.T.text_width(note_text, generate.T.FONT_NOTE),
        )
        self.assertGreaterEqual(
            note["height"],
            generate.T.text_height(note_text, generate.T.FONT_NOTE),
        )

    def test_wide_latin_glyphs_receive_a_safe_excalifont_width(self):
        label = "W" * 50
        scene = generate.build({
            "title": label,
            "nodes": [{"id": "wide", "label": label}],
            "edges": [],
        })
        node = next(element for element in scene["elements"] if element["id"] == "wide")
        node_text = next(
            element for element in text_elements(scene)
            if element["containerId"] == "wide"
        )

        self.assertGreaterEqual(
            generate.T.text_width(label, generate.T.FONT_NODE),
            50 * 16,
        )
        self.assertGreaterEqual(node_text["width"], 50 * 16)
        self.assertLessEqual(
            node_text["x"] + node_text["width"],
            node["x"] + node["width"],
        )

    def test_lr_layout_places_nodes_below_a_tall_title(self):
        scene = generate.build({
            "title": "\n".join(f"标题{i}" for i in range(10)),
            "direction": "LR",
            "nodes": [{"id": "node", "label": "节点"}],
            "edges": [],
        })
        title = next(element for element in text_elements(scene) if element["containerId"] is None)
        node = next(element for element in scene["elements"] if element["id"] == "node")

        self.assertGreater(node["y"], title["y"] + title["height"])

    def test_multiline_group_and_edge_labels_have_room(self):
        scene = generate.build({
            "groups": [{"id": "g", "label": "分组一\n分组二\n分组三"}],
            "nodes": [
                {"id": "a", "label": "节点 A", "group": "g"},
                {"id": "b", "label": "节点 B", "group": "g"},
            ],
            "edges": [{"from": "a", "to": "b", "label": "第一行\n第二行\n第三行"}],
        })
        group = next(element for element in scene["elements"] if element["id"] == "g")
        group_title = next(
            element for element in text_elements(scene)
            if element["containerId"] is None
        )
        first_node = next(element for element in scene["elements"] if element["id"] == "a")
        edge_label = next(
            element for element in text_elements(scene)
            if element["containerId"] == "arr-0"
        )

        self.assertGreaterEqual(
            group_title["height"],
            3 * group_title["fontSize"] * group_title["lineHeight"],
        )
        self.assertGreater(first_node["y"], group_title["y"] + group_title["height"])
        self.assertLessEqual(first_node["y"] + first_node["height"], group["y"] + group["height"])
        self.assertGreaterEqual(
            edge_label["height"],
            3 * edge_label["fontSize"] * edge_label["lineHeight"],
        )

    def test_edge_labels_do_not_overlap_endpoint_nodes_in_any_layout(self):
        cases = [
            ("TB", [], "一\n二\n三\n四\n五\n六"),
            ("LR", [], "relationship"),
            ("TB", [{"id": "g", "label": "分组"}], "一\n二\n三\n四\n五\n六"),
        ]
        for direction, groups, label in cases:
            with self.subTest(direction=direction, grouped=bool(groups)):
                nodes = [{"id": "a"}, {"id": "b"}]
                if groups:
                    for node in nodes:
                        node["group"] = "g"
                scene = generate.build({
                    "direction": direction,
                    "groups": groups,
                    "nodes": nodes,
                    "edges": [{"from": "a", "to": "b", "label": label}],
                })
                by_id = {element["id"]: element for element in scene["elements"]}
                edge_label = next(
                    element for element in text_elements(scene)
                    if element["containerId"] == "arr-0"
                )
                self.assert_boxes_do_not_intersect(edge_label, by_id["a"])
                self.assert_boxes_do_not_intersect(edge_label, by_id["b"])

    def test_empty_group_container_grows_to_contain_a_multiline_title(self):
        scene = generate.build({
            "groups": [{
                "id": "empty",
                "label": "\n".join(f"分组标题{i}" for i in range(10)),
            }],
            "nodes": [],
            "edges": [],
        })
        group = next(element for element in scene["elements"] if element["id"] == "empty")
        title = next(element for element in text_elements(scene))

        self.assertLessEqual(title["y"] + title["height"], group["y"] + group["height"])

    def test_long_group_title_expands_its_container_width(self):
        label = "这是一个非常长的中文分组标题" * 3
        scene = generate.build({
            "groups": [{"id": "group", "label": label}],
            "nodes": [],
            "edges": [],
        })
        group = next(element for element in scene["elements"] if element["id"] == "group")
        required_width = generate.T.text_width(
            label,
            generate.T.FONT_SECTION,
            padding=2 * generate.T.CONTAINER_PAD,
        )

        self.assertGreaterEqual(group["width"], required_width)

    def test_non_rectangular_nodes_expand_for_their_inscribed_text_region(self):
        label = "非常长的第一行文字\n第二行\n第三行\n第四行\n第五行"
        for node_spec, factor in (
            ({"id": "diamond", "role": "decision", "label": label}, 0.5),
            ({"id": "ellipse", "shape": "ellipse", "label": label}, 0.7),
        ):
            with self.subTest(node=node_spec["id"]):
                scene = generate.build({"nodes": [node_spec], "edges": []})
                node = next(
                    element for element in scene["elements"]
                    if element["id"] == node_spec["id"]
                )
                required_width = generate.T.text_width(label, generate.T.FONT_NODE)
                required_height = generate.T.text_height(label, generate.T.FONT_NODE)

                self.assertLessEqual(required_width, node["width"] * factor)
                self.assertLessEqual(required_height, node["height"] * factor)


class InputValidationTests(unittest.TestCase):
    def assert_invalid(self, spec, message):
        with self.assertRaisesRegex(ValueError, message):
            generate.build(spec)

    def test_rejects_unknown_enum_values_instead_of_silently_changing_them(self):
        cases = [
            ({"direction": "SIDEWAYS", "nodes": [{"id": "n"}]}, "direction"),
            ({"nodes": [{"id": "n", "shape": "hexagon"}]}, "shape"),
            ({"nodes": [{"id": "n", "fill": "sprinkles"}]}, "fill"),
            ({"groups": [{"id": "g", "fill": "sprinkles"}], "nodes": []}, "fill"),
            ({
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"from": "a", "to": "b", "style": "wavy"}],
            }, "style"),
            ({
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"from": "a", "to": "b", "arrow": "middle"}],
            }, "arrow"),
        ]

        for spec, message in cases:
            with self.subTest(spec=spec):
                self.assert_invalid(spec, message)

    def test_rejects_unknown_groups_self_loops_and_invalid_ids(self):
        cases = [
            ({
                "groups": [{"id": "known"}],
                "nodes": [{"id": "n", "group": "missing"}],
            }, "unknown group"),
            ({
                "nodes": [{"id": "n"}],
                "edges": [{"from": "n", "to": "n"}],
            }, "self-loop"),
            ({"nodes": [{"id": ""}]}, "non-empty string"),
            ({"nodes": [{"id": "n"}, {"id": "n"}]}, "duplicate node"),
            ({
                "nodes": [{"id": "n"}],
                "edges": [{"from": "n", "to": "missing"}],
            }, "unknown node"),
        ]

        for spec, message in cases:
            with self.subTest(spec=spec):
                self.assert_invalid(spec, message)

    def test_rejects_malformed_structure_types_and_non_finite_numbers(self):
        cases = [
            (None, "object"),
            ({"nodes": None}, "nodes"),
            ({"nodes": "not-a-list"}, "nodes"),
            ({"theme": "drak"}, "theme"),
            ({"theme": []}, "theme"),
            ({"nodes": [{"id": "n", "role": "servcie"}]}, "role"),
            ({"groups": [{"id": "g", "role": "servcie"}]}, "role"),
            ({"nodes": [{"id": "n", "label": 123}]}, "label"),
            ({"groups": [{"id": "g"}], "nodes": [{"id": "n", "group": []}]}, "group"),
            ({"notes": [{"x": 0, "y": 0}]}, "text"),
            ({"notes": [{"x": math.nan, "y": 0, "text": "note"}]}, "finite"),
            ({"notes": [{"x": 0, "y": 0, "text": "note", "size": 0}]}, "positive"),
            ({"notes": [{"x": 1e308, "y": 0, "text": "note"}]}, "safe range"),
            ({"notes": [{"x": 0, "y": 0, "text": "note", "size": 1e308}]}, "safe range"),
            ({
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"from": "a", "to": "b", "label": 123}],
            }, "label"),
            ({
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"from": [], "to": "b"}],
            }, "from"),
            ({
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"from": "a", "to": "b", "arrowhead": []}],
            }, "arrowhead"),
        ]

        for spec, message in cases:
            with self.subTest(spec=spec):
                self.assert_invalid(spec, message)

    def test_rejects_text_that_expands_beyond_the_renderer_geometry_limit(self):
        self.assert_invalid({
            "title": "W" * 331_000,
            "nodes": [{"id": "node"}],
        }, "geometry exceeds the safe range")

    def test_rejects_strings_that_cannot_be_encoded_as_utf8(self):
        invalid = "\ud800"
        cases = (
            {"nodes": [{"id": invalid}]},
            {"title": invalid, "nodes": []},
            {"nodes": [{"id": "node", "label": invalid}]},
            {"groups": [{"id": "group", "label": invalid}], "nodes": []},
            {"notes": [{"x": 0, "y": 0, "text": invalid}]},
            {
                "nodes": [{"id": "a"}, {"id": "b"}],
                "edges": [{"from": "a", "to": "b", "label": invalid}],
            },
        )

        for spec in cases:
            with self.subTest(spec=spec):
                self.assert_invalid(spec, "valid UTF-8")

    def test_rejects_parallel_or_reverse_edges_that_would_render_on_top_of_each_other(self):
        for edges in (
            [{"from": "a", "to": "b"}, {"from": "a", "to": "b"}],
            [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}],
        ):
            with self.subTest(edges=edges):
                self.assert_invalid({
                    "nodes": [{"id": "a"}, {"id": "b"}],
                    "edges": edges,
                }, "multiple edges")

    def test_rejects_dense_labeled_graphs_before_expensive_automatic_routing(self):
        nodes = [{"id": f"n{index}"} for index in range(10)]
        dense_edges = [
            {"from": f"n{source}", "to": f"n{target}", "label": "relation"}
            for source in range(10)
            for target in range(source + 1, 10)
        ]
        self.assert_invalid(
            {"nodes": nodes, "edges": dense_edges},
            "too many labeled edges",
        )

        sparse_nodes = [{"id": f"n{index}"} for index in range(100)]
        sparse_edges = [
            {"from": f"n{index}", "to": f"n{index + 1}", "label": "next"}
            for index in range(99)
        ]
        scene = generate.build({"nodes": sparse_nodes, "edges": sparse_edges})
        self.assertEqual(
            sum(element["type"] == "arrow" for element in scene["elements"]),
            99,
        )


class CliSafetyTests(unittest.TestCase):
    def test_cli_rejects_overwriting_its_input_spec(self):
        for target in ("scene", "obsidian"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as tmpdir:
                spec_path = Path(tmpdir) / "spec.json"
                original = json.dumps({"nodes": [{"id": "keep"}], "edges": []})
                spec_path.write_text(original, encoding="utf-8")
                args = [
                    sys.executable,
                    str(MODULE_PATH),
                    str(spec_path),
                    "--out", str(Path(tmpdir) / "scene.excalidraw"),
                ]
                if target == "scene":
                    args[-1] = str(spec_path)
                else:
                    args.extend(("--obsidian", str(spec_path)))

                result = subprocess.run(
                    args,
                    check=False,
                    capture_output=True,
                    text=True,
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertIn("input spec", result.stderr)
                self.assertEqual(spec_path.read_text(encoding="utf-8"), original)

    def test_atomic_write_accepts_a_single_pass_output_iterable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            first = Path(tmpdir) / "first.txt"
            second = Path(tmpdir) / "second.txt"
            outputs = ((path, content) for path, content in (
                (first, "first"),
                (second, "second"),
            ))

            generate._atomic_write_texts(outputs)

            self.assertEqual(first.read_text(encoding="utf-8"), "first")
            self.assertEqual(second.read_text(encoding="utf-8"), "second")

    def test_failed_obsidian_validation_does_not_overwrite_either_output(self):
        invalid_spec = {
            "nodes": [{"id": "n", "label": "before ^12345678\nafter"}],
            "edges": [],
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            spec_path = root / "spec.json"
            scene_path = root / "scene.excalidraw"
            markdown_path = root / "scene.excalidraw.md"
            spec_path.write_text(json.dumps(invalid_spec), encoding="utf-8")
            scene_path.write_text("old scene", encoding="utf-8")
            markdown_path.write_text("old markdown", encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    str(spec_path),
                    "--out", str(scene_path),
                    "--obsidian", str(markdown_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(scene_path.read_text(encoding="utf-8"), "old scene")
            self.assertEqual(markdown_path.read_text(encoding="utf-8"), "old markdown")

    def test_atomic_multi_file_write_rolls_back_and_preserves_normal_permissions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            first = root / "first.txt"
            second = root / "second.txt"
            first.write_text("old first", encoding="utf-8")
            second.write_text("old second", encoding="utf-8")
            first.chmod(0o644)
            second.chmod(0o640)
            real_replace = generate.os.replace
            failed = False

            def fail_second_commit(source, destination):
                nonlocal failed
                if (
                    not failed
                    and Path(destination) == second
                    and str(source).endswith(".tmp")
                ):
                    failed = True
                    raise OSError("simulated second commit failure")
                return real_replace(source, destination)

            with (
                mock.patch.object(generate.os, "replace", side_effect=fail_second_commit),
                self.assertRaisesRegex(OSError, "second commit"),
            ):
                generate._atomic_write_texts([
                    (first, "new first"),
                    (second, "new second"),
                ])

            self.assertEqual(first.read_text(encoding="utf-8"), "old first")
            self.assertEqual(second.read_text(encoding="utf-8"), "old second")
            self.assertEqual(first.stat().st_mode & 0o777, 0o644)
            self.assertEqual(second.stat().st_mode & 0o777, 0o640)

            created = root / "created.txt"
            current_umask = os.umask(0)
            os.umask(current_umask)
            generate._atomic_write_texts([(created, "created")])
            self.assertEqual(created.stat().st_mode & 0o777, 0o666 & ~current_umask)

    def test_atomic_write_rejects_directory_destinations_without_moving_them(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            destination = Path(tmpdir) / "output"
            destination.mkdir()
            valuable = destination / "valuable.txt"
            valuable.write_text("keep me", encoding="utf-8")

            with self.assertRaises(IsADirectoryError):
                generate._atomic_write_texts([(destination, "replacement")])

            self.assertTrue(destination.is_dir())
            self.assertEqual(valuable.read_text(encoding="utf-8"), "keep me")

    def test_atomic_write_rejects_symlinks_and_duplicate_destinations(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            original = root / "original.txt"
            link = root / "link.txt"
            original.write_text("keep me", encoding="utf-8")
            link.symlink_to(original)

            with self.assertRaisesRegex(ValueError, "symbolic link"):
                generate._atomic_write_texts([(link, "replacement")])
            with self.assertRaisesRegex(ValueError, "unique"):
                generate._atomic_write_texts([
                    (original, "first"),
                    (root / "." / "original.txt", "second"),
                ])

            self.assertTrue(link.is_symlink())
            self.assertEqual(original.read_text(encoding="utf-8"), "keep me")

    def test_atomic_write_backup_failure_leaves_all_targets_unchanged(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            first = root / "first.txt"
            second = root / "second.txt"
            first.write_text("old first", encoding="utf-8")
            second.write_text("old second", encoding="utf-8")

            with mock.patch.object(
                generate.shutil,
                "copy2",
                side_effect=OSError("simulated backup failure"),
            ), self.assertRaisesRegex(OSError, "backup failure"):
                generate._atomic_write_texts([
                    (first, "new first"),
                    (second, "new second"),
                ])

            self.assertEqual(first.read_text(encoding="utf-8"), "old first")
            self.assertEqual(second.read_text(encoding="utf-8"), "old second")
            self.assertEqual(list(root.glob("*.bak")), [])

    def test_atomic_write_retains_backup_if_rollback_itself_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            first = root / "first.txt"
            second = root / "second.txt"
            first.write_text("old first", encoding="utf-8")
            second.write_text("old second", encoding="utf-8")
            real_replace = generate.os.replace

            def fail_commit_and_restore(source, destination):
                source = Path(source)
                destination = Path(destination)
                if destination == second and source.suffix == ".tmp":
                    raise OSError("simulated commit failure")
                if destination == first and source.suffix == ".bak":
                    raise OSError("simulated rollback failure")
                return real_replace(source, destination)

            with (
                mock.patch.object(
                    generate.os,
                    "replace",
                    side_effect=fail_commit_and_restore,
                ),
                self.assertRaisesRegex(RuntimeError, "backups retained"),
            ):
                generate._atomic_write_texts([
                    (first, "new first"),
                    (second, "new second"),
                ])

            retained = list(root.glob(".first.*.bak"))
            self.assertEqual(len(retained), 1)
            self.assertEqual(retained[0].read_text(encoding="utf-8"), "old first")
            self.assertEqual(second.read_text(encoding="utf-8"), "old second")


class SceneInvariantTests(unittest.TestCase):
    def test_free_notes_are_above_solid_group_backgrounds(self):
        scene = generate.build({
            "groups": [{"id": "zone", "fill": "solid"}],
            "nodes": [{"id": "inside", "group": "zone"}],
            "notes": [{"x": 60, "y": 120, "text": "must stay visible"}],
            "edges": [],
        })
        elements = scene["elements"]
        group_index = next(i for i, element in enumerate(elements) if element["id"] == "zone")
        note_index = next(
            i for i, element in enumerate(elements)
            if element["type"] == "text" and element["originalText"] == "must stay visible"
        )

        self.assertLess(group_index, note_index)

    def test_dark_scene_declares_dark_excalidraw_app_state(self):
        scene = generate.build({"theme": "dark", "nodes": [], "edges": []})

        self.assertEqual(scene["appState"]["theme"], "dark")

    def test_generated_scene_matrix_preserves_ids_bindings_geometry_and_markdown_mapping(self):
        for theme, direction, grouped in itertools.product(
            ("soft", "mono", "vivid", "dark"),
            ("TB", "LR"),
            (False, True),
        ):
            with self.subTest(theme=theme, direction=direction, grouped=grouped):
                nodes = [
                    {"id": "a", "label": "短标签", "role": "client"},
                    {"id": "b", "label": "多行\n标签\n三行\n四行", "role": "decision"},
                    {"id": "c", "label": "Latin and 中文", "shape": "ellipse"},
                ]
                groups = []
                if grouped:
                    groups = [
                        {"id": "left", "label": "左侧\n分组", "role": "client"},
                        {"id": "right", "label": "右侧", "role": "store"},
                    ]
                    nodes[0]["group"] = "left"
                    nodes[1]["group"] = "left"
                    nodes[2]["group"] = "right"
                spec = {
                    "title": "结构不变量\n验收",
                    "theme": theme,
                    "direction": direction,
                    "groups": groups,
                    "nodes": nodes,
                    "edges": [
                        {"from": "a", "to": "b", "label": "第一步\n继续"},
                        {"from": "b", "to": "c", "arrow": "both", "style": "dashed"},
                    ],
                    "notes": [{"x": 20, "y": 600, "text": "备注\n第二行"}],
                }
                scene = generate.build(spec)
                elements = scene["elements"]
                by_id = {element["id"]: element for element in elements}

                self.assertEqual(len(by_id), len(elements))
                for text in text_elements(scene):
                    self.assertRegex(text["id"], r"^[A-Za-z0-9]{8}$")
                    if text["containerId"]:
                        container = by_id[text["containerId"]]
                        self.assertIn(
                            {"id": text["id"], "type": "text"},
                            container["boundElements"],
                        )
                        if container["type"] != "arrow":
                            self.assertGreaterEqual(text["y"], container["y"])
                            self.assertLessEqual(
                                text["y"] + text["height"],
                                container["y"] + container["height"],
                            )

                for arrow in (element for element in elements if element["type"] == "arrow"):
                    self.assertEqual(arrow["width"], abs(arrow["points"][-1][0]))
                    self.assertEqual(arrow["height"], abs(arrow["points"][-1][1]))
                    for binding_name in ("startBinding", "endBinding"):
                        shape = by_id[arrow[binding_name]["elementId"]]
                        self.assertIn(
                            {"id": arrow["id"], "type": "arrow"},
                            shape["boundElements"],
                        )

                with tempfile.TemporaryDirectory() as tmpdir:
                    output_path = Path(tmpdir) / "matrix.excalidraw.md"
                    generate.to_obsidian_md(scene, output_path)
                    markdown = output_path.read_text(encoding="utf-8")
                section = markdown.split("## Text Elements\n", 1)[1].split("\n%%", 1)[0]
                self.assertEqual(
                    re.findall(r"\s\^(.{8})[\n]+", section),
                    [element["id"] for element in text_elements(scene)],
                )

    def test_build_is_fully_deterministic_within_one_process(self):
        self.assertEqual(generate.build(SCENE_SPEC), generate.build(SCENE_SPEC))

if __name__ == "__main__":
    unittest.main()
