use crate::style::computed::FilterOperation;

/// Apply ordered filter color operations to one straight-alpha sRGB color.
///
/// Geometry-producing operations are intentionally neutral here: they require
/// a complete source surface and are handled by the surface evaluator.
pub(crate) fn apply_operations_to_color(
    color: (f32, f32, f32, f32),
    operations: &[FilterOperation],
    linear_rgb: bool,
) -> (f32, f32, f32, f32) {
    let (mut red, mut green, mut blue, mut alpha) = color;
    if linear_rgb {
        red = srgb_to_linear(red);
        green = srgb_to_linear(green);
        blue = srgb_to_linear(blue);
    }
    let (mut red, mut green, mut blue) = (red * 255.0, green * 255.0, blue * 255.0);
    for operation in operations {
        match *operation {
            FilterOperation::Opacity(amount) => alpha *= amount,
            FilterOperation::Matrix(matrix) => {
                let source_alpha = alpha * 255.0;
                let next_red = matrix[0] * red
                    + matrix[1] * green
                    + matrix[2] * blue
                    + matrix[3] * source_alpha
                    + matrix[4] * 255.0;
                let next_green = matrix[5] * red
                    + matrix[6] * green
                    + matrix[7] * blue
                    + matrix[8] * source_alpha
                    + matrix[9] * 255.0;
                let next_blue = matrix[10] * red
                    + matrix[11] * green
                    + matrix[12] * blue
                    + matrix[13] * source_alpha
                    + matrix[14] * 255.0;
                let next_alpha = matrix[15] * red
                    + matrix[16] * green
                    + matrix[17] * blue
                    + matrix[18] * source_alpha
                    + matrix[19] * 255.0;
                red = next_red.clamp(0.0, 255.0);
                green = next_green.clamp(0.0, 255.0);
                blue = next_blue.clamp(0.0, 255.0);
                alpha = (next_alpha / 255.0).clamp(0.0, 1.0);
            }
            FilterOperation::Brightness(amount) => {
                red *= amount;
                green *= amount;
                blue *= amount;
            }
            FilterOperation::Contrast(amount) => {
                red = (red - 127.5) * amount + 127.5;
                green = (green - 127.5) * amount + 127.5;
                blue = (blue - 127.5) * amount + 127.5;
            }
            FilterOperation::Invert(amount) => {
                red = red * (1.0 - amount) + (255.0 - red) * amount;
                green = green * (1.0 - amount) + (255.0 - green) * amount;
                blue = blue * (1.0 - amount) + (255.0 - blue) * amount;
            }
            FilterOperation::Grayscale(amount) => {
                let retained = 1.0 - amount;
                (red, green, blue) = (
                    (0.2126 + 0.7874 * retained) * red
                        + (0.7152 - 0.7152 * retained) * green
                        + (0.0722 - 0.0722 * retained) * blue,
                    (0.2126 - 0.2126 * retained) * red
                        + (0.7152 + 0.2848 * retained) * green
                        + (0.0722 - 0.0722 * retained) * blue,
                    (0.2126 - 0.2126 * retained) * red
                        + (0.7152 - 0.7152 * retained) * green
                        + (0.0722 + 0.9278 * retained) * blue,
                );
            }
            FilterOperation::Sepia(amount) => {
                let retained = 1.0 - amount;
                (red, green, blue) = (
                    (0.393 + 0.607 * retained) * red
                        + (0.769 - 0.769 * retained) * green
                        + (0.189 - 0.189 * retained) * blue,
                    (0.349 - 0.349 * retained) * red
                        + (0.686 + 0.314 * retained) * green
                        + (0.168 - 0.168 * retained) * blue,
                    (0.272 - 0.272 * retained) * red
                        + (0.534 - 0.534 * retained) * green
                        + (0.131 + 0.869 * retained) * blue,
                );
            }
            FilterOperation::Saturate(amount) => {
                (red, green, blue) = (
                    (0.213 + 0.787 * amount) * red
                        + (0.715 - 0.715 * amount) * green
                        + (0.072 - 0.072 * amount) * blue,
                    (0.213 - 0.213 * amount) * red
                        + (0.715 + 0.285 * amount) * green
                        + (0.072 - 0.072 * amount) * blue,
                    (0.213 - 0.213 * amount) * red
                        + (0.715 - 0.715 * amount) * green
                        + (0.072 + 0.928 * amount) * blue,
                );
            }
            FilterOperation::HueRotate(degrees) => {
                let radians = degrees.to_radians();
                let (cosine, sine) = (radians.cos(), radians.sin());
                (red, green, blue) = (
                    (0.213 + cosine * 0.787 - sine * 0.213) * red
                        + (0.715 - cosine * 0.715 - sine * 0.715) * green
                        + (0.072 - cosine * 0.072 + sine * 0.928) * blue,
                    (0.213 - cosine * 0.213 + sine * 0.143) * red
                        + (0.715 + cosine * 0.285 + sine * 0.140) * green
                        + (0.072 - cosine * 0.072 - sine * 0.283) * blue,
                    (0.213 - cosine * 0.213 - sine * 0.787) * red
                        + (0.715 - cosine * 0.715 + sine * 0.715) * green
                        + (0.072 + cosine * 0.928 + sine * 0.072) * blue,
                );
            }
            FilterOperation::Blur(_)
            | FilterOperation::BlendWithFlood { .. }
            | FilterOperation::Offset { .. }
            | FilterOperation::DropShadow(_)
            | FilterOperation::MorphologyDilate(_) => {}
        }
        red = red.clamp(0.0, 255.0);
        green = green.clamp(0.0, 255.0);
        blue = blue.clamp(0.0, 255.0);
        alpha = alpha.clamp(0.0, 1.0);
    }
    let (mut red, mut green, mut blue) = (red / 255.0, green / 255.0, blue / 255.0);
    if linear_rgb {
        red = linear_to_srgb(red);
        green = linear_to_srgb(green);
        blue = linear_to_srgb(blue);
    }
    (red, green, blue, alpha)
}

fn srgb_to_linear(component: f32) -> f32 {
    if component <= 0.04045 {
        component / 12.92
    } else {
        ((component + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(component: f32) -> f32 {
    if component <= 0.0031308 {
        12.92 * component
    } else {
        1.055 * component.powf(1.0 / 2.4) - 0.055
    }
}
