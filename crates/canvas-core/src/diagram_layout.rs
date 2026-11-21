//! Bounded graph layout: ranked flows, grouped architecture/teaching boards,
//! and balanced two-sided mind maps. Coordinates are always harness-owned.
use crate::{
    diagram::{dimensions, Diagram},
    CanvasError, Layout, Region,
};
use std::collections::HashMap;

pub(crate) struct Band {
    pub title: String,
    pub region: Region,
}
pub(crate) struct Placement {
    pub boxes: Vec<Region>,
    pub bands: Vec<Band>,
    pub branches: Vec<usize>,
}

pub(crate) fn place(graph: &Diagram, layout: Layout) -> Result<Placement, CanvasError> {
    let mut placed = Placement {
        boxes: graph
            .nodes
            .iter()
            .map(|node| dimensions(node, layout))
            .collect(),
        bands: vec![],
        branches: vec![0; graph.nodes.len()],
    };
    match layout {
        Layout::Flowchart => flow(graph, &mut placed),
        Layout::Mindmap => mindmap(graph, &mut placed)?,
        Layout::Architecture | Layout::Lesson => grouped(graph, &mut placed, layout),
        _ => return Err(CanvasError::Invalid("unsupported diagram layout".into())),
    }
    Ok(placed)
}

fn flow(graph: &Diagram, placed: &mut Placement) {
    let n = graph.nodes.len();
    let index: HashMap<_, _> = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (&n.id, i))
        .collect();
    let mut reachable = vec![vec![false; n]; n];
    for edge in &graph.edges {
        reachable[index[&edge.from]][index[&edge.to]] = true;
    }
    for k in 0..n {
        for i in 0..n {
            for j in 0..n {
                reachable[i][j] |= reachable[i][k] && reachable[k][j];
            }
        }
    }
    // Collapse cycles for ranking; feedback edges are subsequently routed around nodes.
    let mut component = vec![usize::MAX; n];
    let mut count = 0;
    for i in 0..n {
        if component[i] != usize::MAX {
            continue;
        }
        component[i] = count;
        for j in i + 1..n {
            if reachable[i][j] && reachable[j][i] {
                component[j] = count;
            }
        }
        count += 1;
    }
    let mut ranks = vec![0; count];
    for _ in 0..count {
        for edge in &graph.edges {
            let a = component[index[&edge.from]];
            let b = component[index[&edge.to]];
            if a != b {
                ranks[b] = ranks[b].max(ranks[a] + 1);
            }
        }
    }
    let levels: Vec<Vec<_>> = (0..=*ranks.iter().max().unwrap())
        .map(|level| (0..n).filter(|i| ranks[component[*i]] == level).collect())
        .collect();
    let max_width = levels
        .iter()
        .map(|row| {
            row.iter().map(|i| placed.boxes[*i].width).sum::<f64>()
                + 160.0 * row.len().saturating_sub(1) as f64
        })
        .fold(0.0, f64::max);
    let mut y = 0.0;
    for (level, row) in levels.into_iter().enumerate() {
        let width = row.iter().map(|i| placed.boxes[*i].width).sum::<f64>()
            + 160.0 * row.len().saturating_sub(1) as f64;
        let height = row
            .iter()
            .map(|i| placed.boxes[*i].height)
            .fold(0.0, f64::max);
        let mut x = (max_width - width) / 2.0;
        for i in row {
            placed.boxes[i].x = x;
            placed.boxes[i].y = y + (height - placed.boxes[i].height) / 2.0;
            x += placed.boxes[i].width + 160.0;
            placed.branches[i] = level;
        }
        y += height + 152.0;
    }
}

fn grouped(graph: &Diagram, placed: &mut Placement, layout: Layout) {
    let mut groups: Vec<(String, Vec<usize>)> = graph
        .groups
        .iter()
        .map(|g| {
            (
                g.title.clone(),
                graph
                    .nodes
                    .iter()
                    .enumerate()
                    .filter(|(_, n)| n.group.as_deref() == Some(&g.id))
                    .map(|(i, _)| i)
                    .collect(),
            )
        })
        .collect();
    let loose: Vec<_> = graph
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.group.is_none())
        .map(|(i, _)| i)
        .collect();
    if !loose.is_empty() {
        if matches!(layout, Layout::Lesson) {
            for i in loose {
                groups.push((graph.nodes[i].title.clone(), vec![i]));
            }
        } else {
            groups.push(("协作组件".into(), loose));
        }
    }
    let columns = if matches!(layout, Layout::Lesson) {
        2
    } else {
        3
    };
    let cell_width = placed.boxes.iter().map(|r| r.width).fold(280.0, f64::max);
    let widest = groups
        .iter()
        .map(|(_, g)| g.len().min(columns))
        .max()
        .unwrap_or(1);
    let band_width = 64.0 + widest as f64 * cell_width + 128.0 * widest.saturating_sub(1) as f64;
    let mut y = 0.0;
    for (group, (title, members)) in groups.into_iter().enumerate() {
        let start = y;
        y += if title.trim().is_empty() { 24.0 } else { 70.0 };
        for row in members.chunks(columns) {
            let height = row
                .iter()
                .map(|i| placed.boxes[*i].height)
                .fold(0.0, f64::max);
            for (col, i) in row.iter().enumerate() {
                placed.boxes[*i].x = 32.0
                    + col as f64 * (cell_width + 128.0)
                    + (cell_width - placed.boxes[*i].width) / 2.0;
                placed.boxes[*i].y = y;
                placed.branches[*i] = group;
            }
            y += height + 96.0;
        }
        y -= 64.0;
        placed.bands.push(Band {
            title,
            region: Region {
                x: 0.0,
                y: start,
                width: band_width,
                height: y - start,
            },
        });
        y += 120.0;
    }
}

fn mindmap(graph: &Diagram, placed: &mut Placement) -> Result<(), CanvasError> {
    let n = graph.nodes.len();
    let index: HashMap<_, _> = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (&n.id, i))
        .collect();
    let mut children = vec![vec![]; n];
    let mut parents = vec![None; n];
    for edge in &graph.edges {
        let from = index[&edge.from];
        let to = index[&edge.to];
        children[from].push(to);
        parents[to] = Some(from);
    }
    let root = parents
        .iter()
        .position(Option::is_none)
        .ok_or_else(|| CanvasError::Invalid("mindmap root missing".into()))?;
    fn measure(
        i: usize,
        children: &[Vec<usize>],
        boxes: &[Region],
        heights: &mut [f64],
        depth: usize,
    ) -> Result<f64, CanvasError> {
        if depth > 6 {
            return Err(CanvasError::Limit(
                "头脑风暴最多支持 6 层分支，请拆为多个分区".into(),
            ));
        }
        let mut total = 0.0;
        for child in &children[i] {
            total += measure(*child, children, boxes, heights, depth + 1)? + 48.0;
        }
        heights[i] = boxes[i].height.max((total - 48.0).max(0.0));
        Ok(heights[i])
    }
    let mut heights = vec![0.0; n];
    measure(root, &children, &placed.boxes, &mut heights, 0)?;
    let mut sides = [vec![], vec![]];
    let mut totals = [0.0, 0.0];
    for (branch, child) in children[root].iter().enumerate() {
        let side = usize::from(totals[1] < totals[0]);
        sides[side].push((*child, branch + 1));
        totals[side] += heights[*child] + 48.0;
    }
    let height = totals[0].max(totals[1]).max(placed.boxes[root].height);
    placed.boxes[root].x = 0.0;
    placed.boxes[root].y = (height - placed.boxes[root].height) / 2.0;
    struct Tree<'a> {
        children: &'a [Vec<usize>],
        heights: &'a [f64],
    }
    fn position(
        tree: &Tree<'_>,
        placed: &mut Placement,
        i: usize,
        x: f64,
        y: f64,
        direction: f64,
        branch: usize,
    ) {
        placed.boxes[i].x = x;
        placed.boxes[i].y = y + (tree.heights[i] - placed.boxes[i].height) / 2.0;
        placed.branches[i] = branch;
        let mut cursor = y;
        for child in &tree.children[i] {
            let child_x = if direction > 0.0 {
                x + placed.boxes[i].width + 156.0
            } else {
                x - placed.boxes[*child].width - 156.0
            };
            position(tree, placed, *child, child_x, cursor, direction, branch);
            cursor += tree.heights[*child] + 48.0;
        }
    }
    let tree = Tree {
        children: &children,
        heights: &heights,
    };
    for (side, members) in sides.into_iter().enumerate() {
        let mut y = (height - totals[side] + 48.0) / 2.0;
        let direction = if side == 0 { 1.0 } else { -1.0 };
        for (i, branch) in members {
            let x = if side == 0 {
                placed.boxes[root].width + 156.0
            } else {
                -placed.boxes[i].width - 156.0
            };
            position(&tree, placed, i, x, y, direction, branch);
            y += heights[i] + 48.0;
        }
    }
    let min_x = placed.boxes.iter().map(|r| r.x).fold(0.0, f64::min);
    for r in &mut placed.boxes {
        r.x -= min_x;
    }
    Ok(())
}
