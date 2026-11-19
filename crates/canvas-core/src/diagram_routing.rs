//! Orthogonal visibility-grid routing. Only free-space segments are admissible;
//! a diagram is rejected rather than drawing a connector through an unrelated node.
use crate::{
    composition::{text_height, wrapped},
    CanvasError, Region,
};
use std::{cmp::Reverse, collections::BinaryHeap};
type Point = (f64, f64);

fn simplify(points: impl IntoIterator<Item = Point>) -> Vec<Point> {
    let mut output: Vec<Point> = vec![];
    for point in points {
        if output
            .last()
            .is_some_and(|p| (p.0 - point.0).abs() < 0.001 && (p.1 - point.1).abs() < 0.001)
        {
            continue;
        }
        while output.len() > 1 {
            let p = output[output.len() - 2];
            let q = output[output.len() - 1];
            let collinear = ((p.0 - q.0).abs() < 0.001 && (q.0 - point.0).abs() < 0.001)
                || ((p.1 - q.1).abs() < 0.001 && (q.1 - point.1).abs() < 0.001);
            if collinear && (q.0 - p.0) * (point.0 - q.0) + (q.1 - p.1) * (point.1 - q.1) >= 0.0 {
                output.pop();
            } else {
                break;
            }
        }
        output.push(point);
    }
    output
}

fn padded(r: Region, pad: f64) -> Region {
    Region {
        x: r.x - pad,
        y: r.y - pad,
        width: r.width + pad * 2.0,
        height: r.height + pad * 2.0,
    }
}
pub(crate) fn clear(a: Point, b: Point, obstacles: &[Region]) -> bool {
    obstacles.iter().all(|r| {
        if (a.1 - b.1).abs() < 0.001 {
            a.1 <= r.y
                || a.1 >= r.y + r.height
                || a.0.max(b.0) <= r.x
                || a.0.min(b.0) >= r.x + r.width
        } else if (a.0 - b.0).abs() < 0.001 {
            a.0 <= r.x
                || a.0 >= r.x + r.width
                || a.1.max(b.1) <= r.y
                || a.1.min(b.1) >= r.y + r.height
        } else {
            false
        }
    })
}

pub(crate) fn route(
    boxes: &[Region],
    from: usize,
    to: usize,
    edge: usize,
) -> Result<Vec<Point>, CanvasError> {
    let a = boxes[from];
    let b = boxes[to];
    let dx = b.x + b.width / 2.0 - a.x - a.width / 2.0;
    let dy = b.y + b.height / 2.0 - a.y - a.height / 2.0;
    // 0 right, 1 bottom, 2 left, 3 top. Identical endpoints form an external loop.
    let side = if from == to {
        0
    } else if dy.abs() > dx.abs() * 0.65 {
        if dy >= 0.0 {
            1
        } else {
            3
        }
    } else if dx >= 0.0 {
        0
    } else {
        2
    };
    let end_side = if from == to { 3 } else { (side + 2) % 4 };
    let port = |r: Region, side: usize, gap: f64| match side {
        0 => (r.x + r.width + gap, r.y + r.height / 2.0),
        1 => (r.x + r.width / 2.0, r.y + r.height + gap),
        2 => (r.x - gap, r.y + r.height / 2.0),
        _ => (r.x + r.width / 2.0, r.y - gap),
    };
    let start = port(a, side, 8.0);
    let end = port(b, end_side, 8.0);
    let escape = port(a, side, 24.0);
    let enter = port(b, end_side, 24.0);
    let obstacles: Vec<_> = boxes.iter().map(|r| padded(*r, 14.0)).collect();
    // Prefer the centre of the whitespace corridor. A shortest-path tie used to
    // hug a card edge, leaving an unbalanced last bend and cramped labels.
    if from != to {
        let middle = if side % 2 == 1 {
            let y = (escape.1 + enter.1) / 2.0;
            vec![escape, (escape.0, y), (enter.0, y), enter]
        } else {
            let x = (escape.0 + enter.0) / 2.0;
            vec![escape, (x, escape.1), (x, enter.1), enter]
        };
        if middle.windows(2).all(|p| clear(p[0], p[1], &obstacles)) {
            return Ok(simplify([start].into_iter().chain(middle).chain([end])));
        }
    }
    let margin = 24.0 + (edge % 4) as f64 * 8.0;
    let mut xs = vec![escape.0, enter.0];
    let mut ys = vec![escape.1, enter.1];
    for r in boxes {
        xs.extend([r.x - margin, r.x + r.width + margin]);
        ys.extend([r.y - margin, r.y + r.height + margin]);
    }
    xs.sort_by(f64::total_cmp);
    xs.dedup_by(|a, b| (*a - *b).abs() < 0.001);
    ys.sort_by(f64::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() < 0.001);
    let locate = |p: Point| {
        (
            xs.iter().position(|x| (*x - p.0).abs() < 0.001).unwrap(),
            ys.iter().position(|y| (*y - p.1).abs() < 0.001).unwrap(),
        )
    };
    let (sx, sy) = locate(escape);
    let (ex, ey) = locate(enter);
    let start_index = (sy * xs.len() + sx) * 3;
    let length = xs.len() * ys.len() * 3;
    let mut distance = vec![u64::MAX; length];
    let mut previous = vec![usize::MAX; length];
    let mut heap = BinaryHeap::new();
    distance[start_index] = 0;
    heap.push(Reverse((0, start_index)));
    let mut goal = None;
    while let Some(Reverse((cost, state))) = heap.pop() {
        if cost != distance[state] {
            continue;
        }
        let cell = state / 3;
        let direction = state % 3;
        let x = cell % xs.len();
        let y = cell / xs.len();
        if x == ex && y == ey {
            goal = Some(state);
            break;
        }
        let neighbors = [
            x.checked_sub(1).map(|n| (n, y, 1)),
            (x + 1 < xs.len()).then_some((x + 1, y, 1)),
            y.checked_sub(1).map(|n| (x, n, 2)),
            (y + 1 < ys.len()).then_some((x, y + 1, 2)),
        ];
        for (nx, ny, axis) in neighbors.into_iter().flatten() {
            if !clear((xs[x], ys[y]), (xs[nx], ys[ny]), &obstacles) {
                continue;
            }
            let next = (ny * xs.len() + nx) * 3 + axis;
            let next_cost = cost
                + (((xs[x] - xs[nx]).abs() + (ys[y] - ys[ny]).abs()) * 1000.0).round() as u64
                + if direction != 0 && direction != axis {
                    24000
                } else {
                    0
                };
            if next_cost < distance[next] {
                distance[next] = next_cost;
                previous[next] = state;
                heap.push(Reverse((next_cost, next)));
            }
        }
    }
    let mut state =
        goal.ok_or_else(|| CanvasError::Invalid("连线缺少可用通道，请减少节点或拆分图解".into()))?;
    let mut reversed = vec![];
    loop {
        let cell = state / 3;
        reversed.push((xs[cell % xs.len()], ys[cell / xs.len()]));
        if state == start_index {
            break;
        }
        state = previous[state];
    }
    reversed.reverse();
    let mut points = vec![start];
    points.extend(reversed);
    points.push(end);
    let simplified = simplify(points);
    let other: Vec<_> = boxes
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != from && *i != to)
        .map(|(_, r)| *r)
        .collect();
    if simplified.windows(2).any(|p| !clear(p[0], p[1], &other)) {
        return Err(CanvasError::Invalid(
            "连线与其他节点重叠，未追加图解".into(),
        ));
    }
    Ok(simplified)
}

pub(crate) fn label_position(
    points: &[Point],
    boxes: &[Region],
    labels: Vec<Region>,
    text: &str,
) -> Result<Region, CanvasError> {
    // Leave actual breathing room around short labels; exact glyph-width sums
    // can wrap the final CJK character because of fractional font metrics.
    let width = (text.chars().count() as f64 * 14.7 + 16.0)
        .ceil()
        .clamp(44.0, 192.0);
    let height = text_height(&wrapped(text, width, 14.0), 14.0);
    let mut segments: Vec<_> = points.windows(2).collect();
    segments.sort_by(|a, b| {
        ((b[0].0 - b[1].0).abs() + (b[0].1 - b[1].1).abs())
            .total_cmp(&((a[0].0 - a[1].0).abs() + (a[0].1 - a[1].1).abs()))
    });
    for segment in segments {
        let horizontal = (segment[0].1 - segment[1].1).abs() < 0.001;
        for offset in [0.0, -1.0, 1.0] {
            for ratio in [0.5, 0.35, 0.65, 0.2, 0.8] {
                let r = Region {
                    x: segment[0].0 + (segment[1].0 - segment[0].0) * ratio - width / 2.0
                        + if horizontal {
                            0.0
                        } else {
                            offset * (width / 2.0 + 12.0)
                        },
                    y: segment[0].1 + (segment[1].1 - segment[0].1) * ratio - height / 2.0
                        + if horizontal {
                            offset * (height + 12.0)
                        } else {
                            0.0
                        },
                    width,
                    height,
                };
                let pad = padded(r, 8.0);
                if boxes
                    .iter()
                    .chain(labels.iter())
                    .all(|b| !pad.intersects(b))
                {
                    return Ok(r);
                }
            }
        }
    }
    Err(CanvasError::Invalid(
        "连线说明没有足够留白，请缩短说明或拆分图解".into(),
    ))
}
