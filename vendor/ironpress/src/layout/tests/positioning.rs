use super::support::layout_pages;
use crate::layout::elements::LayoutElement;
use crate::style::computed::Position;

fn absolute_offset(target: &str, child: &str, child_tag: &str) -> (f32, f32) {
    let pages = layout_pages(&format!(
        r#"
        <style>
            * {{ margin: 0; box-sizing: border-box; }}
            .frame {{ position: relative; width: 240px; height: 120px; }}
            .target {{ position: absolute; width: 80px; {target} }}
            .child {{ width: 40px; height: 20px; {child} }}
        </style>
        <div class="frame"><div class="target"><{child_tag} class="child"></{child_tag}></div></div>
        "#,
    ));
    let mut offsets = Vec::new();
    for page in &pages {
        for (_, element) in &page.elements {
            collect_absolute_offsets(element.as_ref(), &mut offsets);
        }
    }

    let [offset] = offsets.as_slice() else {
        panic!("expected one absolute box, found {offsets:?}");
    };
    *offset
}

fn collect_absolute_offsets(element: &dyn LayoutElement, offsets: &mut Vec<(f32, f32)>) {
    if let Some(positioning) = element.positioning_owner().map(|owner| owner.positioning())
        && positioning.scheme == Position::Absolute
    {
        offsets.push((positioning.insets.left, positioning.insets.top));
    }
    element.visit_children(&mut |child| collect_absolute_offsets(child, offsets));
}

#[test]
fn absolute_parent_keeps_top_left_offsets_for_normal_flow_children() {
    for (child, child_tag) in [
        ("", "div"),
        ("display: block;", "span"),
        ("display: inline-block;", "div"),
        ("position: relative;", "div"),
    ] {
        assert_eq!(
            absolute_offset("left: 20px; top: 40px;", child, child_tag),
            (15.0, 30.0)
        );
    }
}

#[test]
fn absolute_parent_keeps_bottom_right_offsets_for_a_block_child() {
    assert_eq!(
        absolute_offset("right: 20px; bottom: 16px; height: 20px;", "", "div"),
        (105.0, 63.0),
    );
}
