"""Shared geometry limits for generated and rendered Excalidraw scenes."""

import math

MAX_SCENE_GEOMETRY = 10_000_000


def validate_scene_geometry(elements):
    """Reject element geometry that the renderer cannot safely process."""
    for element in elements:
        x = element.get("x", 0)
        y = element.get("y", 0)
        width = element.get("width", 0)
        height = element.get("height", 0)
        values = (x, y, width, height)
        if any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or abs(value) > MAX_SCENE_GEOMETRY
            for value in values
        ):
            raise ValueError(
                f"element {element.get('id')!r} geometry exceeds the safe range"
            )
        if (
            width < 0
            or height < 0
            or abs(x + width) > MAX_SCENE_GEOMETRY
            or abs(y + height) > MAX_SCENE_GEOMETRY
        ):
            raise ValueError(
                f"element {element.get('id')!r} geometry exceeds the safe range"
            )
        if element.get("type") not in ("arrow", "line") or "points" not in element:
            continue
        points = element["points"]
        if not isinstance(points, list):
            raise ValueError(  # noqa: TRY004 - one public scene validation type
                f"element {element.get('id')!r} points must be a list"
            )
        for point in points:
            if (
                not isinstance(point, list)
                or len(point) != 2
                or any(
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(value)
                    or abs(value) > MAX_SCENE_GEOMETRY
                    for value in point
                )
            ):
                raise ValueError(
                    f"element {element.get('id')!r} points exceed the safe range"
                )
            point_x, point_y = point
            if (
                abs(x + point_x) > MAX_SCENE_GEOMETRY
                or abs(y + point_y) > MAX_SCENE_GEOMETRY
            ):
                raise ValueError(
                    f"element {element.get('id')!r} geometry exceeds the safe range"
                )
