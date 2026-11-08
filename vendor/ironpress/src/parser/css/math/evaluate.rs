use super::ast::{
    AbsoluteLengthUnit, AngleUnit, BinaryExpression, BinaryOperation, FontLengthUnit, Length,
    LengthUnit, LogExpression, MathExpression, MathFunction, MathLiteral, MathType, PairExpression,
    ResolutionUnit, RoundExpression, RoundingStrategy, TimeUnit, ViewportLengthUnit,
};
use super::{LengthPercent, MathUnitContext};

#[derive(Debug, Clone, Copy)]
struct EvaluationContext {
    units: MathUnitContext,
    percentage_basis: Option<f32>,
}

/// A scalar that may still depend linearly on the eventual percentage basis.
/// Typed multiplication can temporarily create squared dimensions, but an
/// unresolved scalar remains representable only while at most one factor
/// carries a percentage. Used-value evaluation resolves the basis first and
/// therefore supports arbitrary dimensional products.
#[derive(Debug, Clone, Copy)]
struct DeferredScalar {
    fixed: f32,
    percent: f32,
}

impl DeferredScalar {
    const fn fixed(value: f32) -> Self {
        Self {
            fixed: value,
            percent: 0.0,
        }
    }

    const fn percentage(value: f32) -> Self {
        Self {
            fixed: 0.0,
            percent: value,
        }
    }

    const fn is_fixed(self) -> bool {
        self.percent == 0.0
    }

    fn resolve(self, basis: f32) -> f32 {
        self.fixed + basis * self.percent / 100.0
    }

    fn multiply(self, rhs: Self) -> Option<Self> {
        if !self.is_fixed() && !rhs.is_fixed() {
            return None;
        }
        Some(Self {
            fixed: self.fixed * rhs.fixed,
            percent: self.percent * rhs.fixed + rhs.percent * self.fixed,
        })
    }

    fn divide(self, rhs: Self) -> Option<Self> {
        rhs.is_fixed().then_some(Self {
            fixed: self.fixed / rhs.fixed,
            percent: self.percent / rhs.fixed,
        })
    }

    fn scale(self, factor: f32) -> Self {
        Self {
            fixed: self.fixed * factor,
            percent: self.percent * factor,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct MathValue {
    scalar: DeferredScalar,
    math_type: MathType,
}

impl MathValue {
    const fn new(scalar: DeferredScalar, math_type: MathType) -> Self {
        Self { scalar, math_type }
    }

    const fn fixed(value: f32, math_type: MathType) -> Self {
        Self::new(DeferredScalar::fixed(value), math_type)
    }
}

pub(super) fn resolve(
    expression: &MathExpression,
    units: MathUnitContext,
    percentage_basis: f32,
) -> Option<f32> {
    let context = EvaluationContext {
        units,
        percentage_basis: Some(percentage_basis),
    };
    let value = evaluate(expression, context)?;
    if !value.math_type.is_length() {
        return None;
    }
    finite(value.scalar.resolve(percentage_basis))
}

pub(super) fn affine(expression: &MathExpression, units: MathUnitContext) -> Option<LengthPercent> {
    let context = EvaluationContext {
        units,
        percentage_basis: None,
    };
    let value = evaluate(expression, context)?;
    if !value.math_type.is_length() {
        return None;
    }
    (value.scalar.fixed.is_finite() && value.scalar.percent.is_finite()).then_some(
        LengthPercent::from_terms(value.scalar.fixed, value.scalar.percent),
    )
}

fn evaluate(expression: &MathExpression, context: EvaluationContext) -> Option<MathValue> {
    match expression {
        MathExpression::Literal(literal) => evaluate_literal(*literal, context),
        MathExpression::Binary(binary) => evaluate_binary(binary, context),
        MathExpression::Function(function) => evaluate_function(function, context),
    }
}

fn evaluate_literal(literal: MathLiteral, context: EvaluationContext) -> Option<MathValue> {
    match literal {
        MathLiteral::Number(value) => Some(MathValue::fixed(value, MathType::NUMBER)),
        MathLiteral::Percentage(value) => Some(MathValue::new(
            context.percentage_basis.map_or_else(
                || DeferredScalar::percentage(value),
                |basis| DeferredScalar::fixed(basis * value / 100.0),
            ),
            MathType::LENGTH_PERCENTAGE,
        )),
        MathLiteral::Length(value) => Some(MathValue::fixed(
            resolve_length(value, context.units)?,
            MathType::LENGTH,
        )),
        MathLiteral::Angle(value) => {
            let radians = match value.unit {
                AngleUnit::Deg => value.value.to_radians(),
                AngleUnit::Grad => value.value * std::f32::consts::PI / 200.0,
                AngleUnit::Rad => value.value,
                AngleUnit::Turn => value.value * std::f32::consts::TAU,
            };
            Some(MathValue::fixed(radians, MathType::ANGLE))
        }
        MathLiteral::Time(value) => Some(MathValue::fixed(
            match value.unit {
                TimeUnit::Second => value.value,
                TimeUnit::Millisecond => value.value / 1000.0,
            },
            MathType::TIME,
        )),
        MathLiteral::Frequency(value) => Some(MathValue::fixed(
            match value.unit {
                super::ast::FrequencyUnit::Hertz => value.value,
                super::ast::FrequencyUnit::Kilohertz => value.value * 1000.0,
            },
            MathType::FREQUENCY,
        )),
        MathLiteral::Resolution(value) => Some(MathValue::fixed(
            match value.unit {
                ResolutionUnit::Inch => value.value,
                ResolutionUnit::Centimeter => value.value * 2.54,
                ResolutionUnit::Pixel => value.value * 96.0,
            },
            MathType::RESOLUTION,
        )),
        MathLiteral::Flex(value) => Some(MathValue::fixed(value.value, MathType::FLEX)),
    }
}

fn evaluate_binary(binary: &BinaryExpression, context: EvaluationContext) -> Option<MathValue> {
    let lhs = evaluate(&binary.lhs, context)?;
    let rhs = evaluate(&binary.rhs, context)?;
    match binary.operation {
        BinaryOperation::Add => add(lhs, rhs),
        BinaryOperation::Subtract => add(lhs, scale(rhs, -1.0)),
        BinaryOperation::Multiply => Some(MathValue::new(
            lhs.scalar.multiply(rhs.scalar)?,
            lhs.math_type.multiply(rhs.math_type)?,
        )),
        BinaryOperation::Divide => Some(MathValue::new(
            lhs.scalar.divide(rhs.scalar)?,
            lhs.math_type.divide(rhs.math_type)?,
        )),
    }
}

fn evaluate_function(function: &MathFunction, context: EvaluationContext) -> Option<MathValue> {
    match function {
        MathFunction::Calc(value) => evaluate(value, context),
        MathFunction::Min(values) => select_extreme(values, context, f32::min),
        MathFunction::Max(values) => select_extreme(values, context, f32::max),
        MathFunction::Clamp(value) => {
            let preferred = evaluate(&value.preferred, context)?;
            let upper_bounded = match &value.maximum {
                Some(maximum) => {
                    combine(preferred, evaluate(maximum, context)?, context, f32::min)?
                }
                None => preferred,
            };
            match &value.minimum {
                Some(minimum) => combine(
                    evaluate(minimum, context)?,
                    upper_bounded,
                    context,
                    f32::max,
                ),
                None => Some(upper_bounded),
            }
        }
        MathFunction::Round(value) => evaluate_round(value, context),
        MathFunction::Mod(value) => evaluate_pair(value, context, modulo),
        MathFunction::Rem(value) => evaluate_pair(value, context, remainder),
        MathFunction::Abs(value) => map(evaluate(value, context)?, context, f32::abs),
        MathFunction::Sign(value) => {
            let value = used_scalar(evaluate(value, context)?, context)?;
            Some(MathValue::fixed(value.signum(), MathType::NUMBER))
        }
        MathFunction::Hypot(values) => {
            let mut values = values.iter();
            let mut result = evaluate(values.next()?, context)?;
            for value in values {
                result = combine(result, evaluate(value, context)?, context, f32::hypot)?;
            }
            map(result, context, f32::abs)
        }
        MathFunction::Sin(value) => trig(evaluate(value, context)?, f32::sin),
        MathFunction::Cos(value) => trig(evaluate(value, context)?, f32::cos),
        MathFunction::Tan(value) => trig(evaluate(value, context)?, f32::tan),
        MathFunction::Asin(value) => inverse_trig(evaluate(value, context)?, f32::asin),
        MathFunction::Acos(value) => inverse_trig(evaluate(value, context)?, f32::acos),
        MathFunction::Atan(value) => inverse_trig(evaluate(value, context)?, f32::atan),
        MathFunction::Atan2(value) => {
            let (first, second) = evaluate_pair_values(value, context)?;
            Some(MathValue::fixed(first.atan2(second), MathType::ANGLE))
        }
        MathFunction::Pow(value) => evaluate_numeric_pair(value, context, f32::powf),
        MathFunction::Sqrt(value) => numeric(evaluate(value, context)?)
            .map(|value| MathValue::fixed(value.sqrt(), MathType::NUMBER)),
        MathFunction::Log(value) => evaluate_log(value, context),
        MathFunction::Exp(value) => numeric(evaluate(value, context)?)
            .map(|value| MathValue::fixed(value.exp(), MathType::NUMBER)),
    }
}

fn select_extreme(
    values: &[MathExpression],
    context: EvaluationContext,
    operation: impl Fn(f32, f32) -> f32 + Copy,
) -> Option<MathValue> {
    let mut values = values.iter();
    let mut result = evaluate(values.next()?, context)?;
    for value in values {
        result = combine(result, evaluate(value, context)?, context, operation)?;
    }
    Some(result)
}

fn evaluate_round(value: &RoundExpression, context: EvaluationContext) -> Option<MathValue> {
    let evaluated = evaluate(&value.value, context)?;
    let interval = match &value.interval {
        Some(interval) => evaluate(interval, context)?,
        None => MathValue::fixed(1.0, MathType::NUMBER),
    };
    let strategy = value.strategy;
    combine(evaluated, interval, context, |value, interval| {
        round(value, interval, strategy)
    })
}

fn evaluate_pair(
    pair: &PairExpression,
    context: EvaluationContext,
    operation: impl Fn(f32, f32) -> f32,
) -> Option<MathValue> {
    combine(
        evaluate(&pair.first, context)?,
        evaluate(&pair.second, context)?,
        context,
        operation,
    )
}

fn evaluate_pair_values(pair: &PairExpression, context: EvaluationContext) -> Option<(f32, f32)> {
    Some((
        used_scalar(evaluate(&pair.first, context)?, context)?,
        used_scalar(evaluate(&pair.second, context)?, context)?,
    ))
}

fn evaluate_numeric_pair(
    pair: &PairExpression,
    context: EvaluationContext,
    operation: impl FnOnce(f32, f32) -> f32,
) -> Option<MathValue> {
    let first = numeric(evaluate(&pair.first, context)?)?;
    let second = numeric(evaluate(&pair.second, context)?)?;
    Some(MathValue::fixed(operation(first, second), MathType::NUMBER))
}

fn evaluate_log(value: &LogExpression, context: EvaluationContext) -> Option<MathValue> {
    let evaluated = numeric(evaluate(&value.value, context)?)?;
    let result = if let Some(base) = &value.base {
        evaluated.log(numeric(evaluate(base, context)?)?)
    } else {
        evaluated.ln()
    };
    Some(MathValue::fixed(result, MathType::NUMBER))
}

fn add(lhs: MathValue, rhs: MathValue) -> Option<MathValue> {
    Some(MathValue::new(
        DeferredScalar {
            fixed: lhs.scalar.fixed + rhs.scalar.fixed,
            percent: lhs.scalar.percent + rhs.scalar.percent,
        },
        lhs.math_type.add(rhs.math_type)?,
    ))
}

fn scale(value: MathValue, factor: f32) -> MathValue {
    MathValue::new(value.scalar.scale(factor), value.math_type)
}

fn combine(
    lhs: MathValue,
    rhs: MathValue,
    context: EvaluationContext,
    operation: impl FnOnce(f32, f32) -> f32,
) -> Option<MathValue> {
    let math_type = lhs.math_type.add(rhs.math_type)?;
    if context.percentage_basis.is_none() && lhs.scalar.percent == rhs.scalar.percent {
        return Some(MathValue::new(
            DeferredScalar {
                fixed: operation(lhs.scalar.fixed, rhs.scalar.fixed),
                percent: lhs.scalar.percent,
            },
            math_type,
        ));
    }
    let basis = context.percentage_basis?;
    Some(MathValue::fixed(
        operation(lhs.scalar.resolve(basis), rhs.scalar.resolve(basis)),
        math_type,
    ))
}

fn map(
    value: MathValue,
    context: EvaluationContext,
    operation: impl FnOnce(f32) -> f32,
) -> Option<MathValue> {
    let scalar = if value.scalar.is_fixed() {
        DeferredScalar::fixed(operation(value.scalar.fixed))
    } else {
        DeferredScalar::fixed(operation(value.scalar.resolve(context.percentage_basis?)))
    };
    Some(MathValue::new(scalar, value.math_type))
}

fn used_scalar(value: MathValue, context: EvaluationContext) -> Option<f32> {
    if value.scalar.is_fixed() {
        Some(value.scalar.fixed)
    } else {
        Some(value.scalar.resolve(context.percentage_basis?))
    }
}

fn numeric(value: MathValue) -> Option<f32> {
    (value.math_type.is_number() && value.scalar.is_fixed()).then_some(value.scalar.fixed)
}

fn trig(value: MathValue, operation: impl FnOnce(f32) -> f32) -> Option<MathValue> {
    ((value.math_type.is_number() || value.math_type.is_angle()) && value.scalar.is_fixed())
        .then(|| MathValue::fixed(operation(value.scalar.fixed), MathType::NUMBER))
}

fn inverse_trig(value: MathValue, operation: impl FnOnce(f32) -> f32) -> Option<MathValue> {
    numeric(value).map(|value| MathValue::fixed(operation(value), MathType::ANGLE))
}

fn round(value: f32, interval: f32, strategy: RoundingStrategy) -> f32 {
    if interval == 0.0 {
        return f32::NAN;
    }
    let interval = interval.abs();
    let units = value / interval;
    let rounded = match strategy {
        RoundingStrategy::Nearest => {
            let lower = units.floor();
            let upper = units.ceil();
            if units - lower < upper - units {
                lower
            } else {
                upper
            }
        }
        RoundingStrategy::Up => units.ceil(),
        RoundingStrategy::Down => units.floor(),
        RoundingStrategy::ToZero => units.trunc(),
    };
    rounded * interval
}

fn remainder(value: f32, interval: f32) -> f32 {
    value % interval
}

fn modulo(value: f32, interval: f32) -> f32 {
    ((value % interval) + interval) % interval
}

fn resolve_length(length: Length, context: MathUnitContext) -> Option<f32> {
    let value = length.value;
    let resolved = match length.unit {
        LengthUnit::Absolute(unit) => resolve_absolute(value, unit),
        LengthUnit::Font(unit) => value * resolve_font(unit, context),
        LengthUnit::Viewport(unit) => value * resolve_viewport(unit, context) / 100.0,
    };
    resolved.is_finite().then_some(resolved)
}

fn resolve_absolute(value: f32, unit: AbsoluteLengthUnit) -> f32 {
    match unit {
        AbsoluteLengthUnit::Px => value * 0.75,
        AbsoluteLengthUnit::In => value * 72.0,
        AbsoluteLengthUnit::Cm => value * 72.0 / 2.54,
        AbsoluteLengthUnit::Mm => value * 72.0 / 25.4,
        AbsoluteLengthUnit::Q => value * 72.0 / 25.4 / 4.0,
        AbsoluteLengthUnit::Pt => value,
        AbsoluteLengthUnit::Pc => value * 12.0,
    }
}

fn resolve_font(unit: FontLengthUnit, context: MathUnitContext) -> f32 {
    let font = context.font;
    match unit {
        FontLengthUnit::Em => font.em,
        FontLengthUnit::Rem => font.rem,
        FontLengthUnit::Ex => font.ex,
        FontLengthUnit::Rex => font.rex,
        FontLengthUnit::Ch => font.ch,
        FontLengthUnit::Rch => font.rch,
        FontLengthUnit::Cap => font.cap,
        FontLengthUnit::Rcap => font.rcap,
        FontLengthUnit::Ic => font.ic,
        FontLengthUnit::Ric => font.ric,
        FontLengthUnit::Lh => font.lh,
        FontLengthUnit::Rlh => font.rlh,
    }
}

fn resolve_viewport(unit: ViewportLengthUnit, context: MathUnitContext) -> f32 {
    let viewport = context.viewport;
    match unit {
        ViewportLengthUnit::Width
        | ViewportLengthUnit::SmallWidth
        | ViewportLengthUnit::LargeWidth
        | ViewportLengthUnit::DynamicWidth => viewport.width,
        ViewportLengthUnit::Height
        | ViewportLengthUnit::SmallHeight
        | ViewportLengthUnit::LargeHeight
        | ViewportLengthUnit::DynamicHeight => viewport.height,
        ViewportLengthUnit::Inline
        | ViewportLengthUnit::SmallInline
        | ViewportLengthUnit::LargeInline
        | ViewportLengthUnit::DynamicInline => viewport.inline,
        ViewportLengthUnit::Block
        | ViewportLengthUnit::SmallBlock
        | ViewportLengthUnit::LargeBlock
        | ViewportLengthUnit::DynamicBlock => viewport.block,
        ViewportLengthUnit::Min
        | ViewportLengthUnit::SmallMin
        | ViewportLengthUnit::LargeMin
        | ViewportLengthUnit::DynamicMin => viewport.width.min(viewport.height),
        ViewportLengthUnit::Max
        | ViewportLengthUnit::SmallMax
        | ViewportLengthUnit::LargeMax
        | ViewportLengthUnit::DynamicMax => viewport.width.max(viewport.height),
    }
}

fn finite(value: f32) -> Option<f32> {
    value.is_finite().then_some(value)
}
