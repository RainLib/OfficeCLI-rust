/// CSS Values 4 calculation type: an exponent for every numeric base type.
///
/// Percentages in this module are parsed in a `<length-percentage>` context,
/// so they carry the length exponent plus the length percent hint. Keeping the
/// hint separate is necessary even when the exponent map is otherwise equal.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct MathType {
    length: i16,
    angle: i16,
    time: i16,
    frequency: i16,
    resolution: i16,
    flex: i16,
    length_percent_hint: bool,
}

impl MathType {
    pub(super) const NUMBER: Self = Self::dimensionless();
    pub(super) const LENGTH: Self = Self {
        length: 1,
        ..Self::dimensionless()
    };
    pub(super) const LENGTH_PERCENTAGE: Self = Self {
        length_percent_hint: true,
        ..Self::LENGTH
    };
    pub(super) const ANGLE: Self = Self {
        angle: 1,
        ..Self::dimensionless()
    };
    pub(super) const TIME: Self = Self {
        time: 1,
        ..Self::dimensionless()
    };
    pub(super) const FREQUENCY: Self = Self {
        frequency: 1,
        ..Self::dimensionless()
    };
    pub(super) const RESOLUTION: Self = Self {
        resolution: 1,
        ..Self::dimensionless()
    };
    pub(super) const FLEX: Self = Self {
        flex: 1,
        ..Self::dimensionless()
    };

    const fn dimensionless() -> Self {
        Self {
            length: 0,
            angle: 0,
            time: 0,
            frequency: 0,
            resolution: 0,
            flex: 0,
            length_percent_hint: false,
        }
    }

    fn combine_exponents(
        self,
        rhs: Self,
        operation: impl Fn(i16, i16) -> Option<i16>,
    ) -> Option<Self> {
        Some(Self {
            length: operation(self.length, rhs.length)?,
            angle: operation(self.angle, rhs.angle)?,
            time: operation(self.time, rhs.time)?,
            frequency: operation(self.frequency, rhs.frequency)?,
            resolution: operation(self.resolution, rhs.resolution)?,
            flex: operation(self.flex, rhs.flex)?,
            length_percent_hint: self.length_percent_hint || rhs.length_percent_hint,
        })
    }

    pub(super) fn multiply(self, rhs: Self) -> Option<Self> {
        self.combine_exponents(rhs, i16::checked_add)
    }

    pub(super) fn divide(self, rhs: Self) -> Option<Self> {
        self.combine_exponents(rhs, i16::checked_sub)
    }

    pub(super) fn add(self, rhs: Self) -> Option<Self> {
        let same_dimensions = Self {
            length_percent_hint: false,
            ..self
        } == Self {
            length_percent_hint: false,
            ..rhs
        };
        same_dimensions.then_some(Self {
            length_percent_hint: self.length_percent_hint || rhs.length_percent_hint,
            ..self
        })
    }

    pub(super) const fn is_number(self) -> bool {
        self.length == 0
            && self.angle == 0
            && self.time == 0
            && self.frequency == 0
            && self.resolution == 0
            && self.flex == 0
    }

    pub(super) const fn is_length(self) -> bool {
        self.length == 1
            && self.angle == 0
            && self.time == 0
            && self.frequency == 0
            && self.resolution == 0
            && self.flex == 0
    }

    pub(super) const fn is_angle(self) -> bool {
        self.length == 0
            && self.angle == 1
            && self.time == 0
            && self.frequency == 0
            && self.resolution == 0
            && self.flex == 0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum MathExpression {
    Literal(MathLiteral),
    Binary(Box<BinaryExpression>),
    Function(Box<MathFunction>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum MathLiteral {
    Number(f32),
    Percentage(f32),
    Length(Length),
    Angle(Angle),
    Time(Time),
    Frequency(Frequency),
    Resolution(Resolution),
    Flex(Flex),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Length {
    pub value: f32,
    pub unit: LengthUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LengthUnit {
    Absolute(AbsoluteLengthUnit),
    Font(FontLengthUnit),
    Viewport(ViewportLengthUnit),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AbsoluteLengthUnit {
    Px,
    In,
    Cm,
    Mm,
    Q,
    Pt,
    Pc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FontLengthUnit {
    Em,
    Rem,
    Ex,
    Rex,
    Ch,
    Rch,
    Cap,
    Rcap,
    Ic,
    Ric,
    Lh,
    Rlh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ViewportLengthUnit {
    Width,
    SmallWidth,
    LargeWidth,
    DynamicWidth,
    Height,
    SmallHeight,
    LargeHeight,
    DynamicHeight,
    Inline,
    SmallInline,
    LargeInline,
    DynamicInline,
    Block,
    SmallBlock,
    LargeBlock,
    DynamicBlock,
    Min,
    SmallMin,
    LargeMin,
    DynamicMin,
    Max,
    SmallMax,
    LargeMax,
    DynamicMax,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Angle {
    pub value: f32,
    pub unit: AngleUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AngleUnit {
    Deg,
    Grad,
    Rad,
    Turn,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Time {
    pub value: f32,
    pub unit: TimeUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TimeUnit {
    Second,
    Millisecond,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Frequency {
    pub value: f32,
    pub unit: FrequencyUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FrequencyUnit {
    Hertz,
    Kilohertz,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Resolution {
    pub value: f32,
    pub unit: ResolutionUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResolutionUnit {
    Inch,
    Centimeter,
    Pixel,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Flex {
    pub value: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct BinaryExpression {
    pub operation: BinaryOperation,
    pub lhs: MathExpression,
    pub rhs: MathExpression,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BinaryOperation {
    Add,
    Subtract,
    Multiply,
    Divide,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum MathFunction {
    Calc(MathExpression),
    Min(Vec<MathExpression>),
    Max(Vec<MathExpression>),
    Clamp(ClampExpression),
    Round(RoundExpression),
    Mod(PairExpression),
    Rem(PairExpression),
    Abs(MathExpression),
    Sign(MathExpression),
    Hypot(Vec<MathExpression>),
    Sin(MathExpression),
    Cos(MathExpression),
    Tan(MathExpression),
    Asin(MathExpression),
    Acos(MathExpression),
    Atan(MathExpression),
    Atan2(PairExpression),
    Pow(PairExpression),
    Sqrt(MathExpression),
    Log(LogExpression),
    Exp(MathExpression),
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ClampExpression {
    pub minimum: Option<MathExpression>,
    pub preferred: MathExpression,
    pub maximum: Option<MathExpression>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct RoundExpression {
    pub strategy: RoundingStrategy,
    pub value: MathExpression,
    pub interval: Option<MathExpression>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RoundingStrategy {
    Nearest,
    Up,
    Down,
    ToZero,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct PairExpression {
    pub first: MathExpression,
    pub second: MathExpression,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct LogExpression {
    pub value: MathExpression,
    pub base: Option<MathExpression>,
}

impl MathExpression {
    pub(super) fn math_type(&self) -> Option<MathType> {
        match self {
            Self::Literal(literal) => Some(literal.math_type()),
            Self::Binary(binary) => binary.math_type(),
            Self::Function(function) => function.math_type(),
        }
    }

    pub(super) fn contains_percentage(&self) -> bool {
        match self {
            Self::Literal(MathLiteral::Percentage(_)) => true,
            Self::Literal(_) => false,
            Self::Binary(binary) => {
                binary.lhs.contains_percentage() || binary.rhs.contains_percentage()
            }
            Self::Function(function) => function.contains_percentage(),
        }
    }
}

impl MathLiteral {
    fn math_type(self) -> MathType {
        match self {
            Self::Number(_) => MathType::NUMBER,
            Self::Percentage(_) => MathType::LENGTH_PERCENTAGE,
            Self::Length(_) => MathType::LENGTH,
            Self::Angle(_) => MathType::ANGLE,
            Self::Time(_) => MathType::TIME,
            Self::Frequency(_) => MathType::FREQUENCY,
            Self::Resolution(_) => MathType::RESOLUTION,
            Self::Flex(_) => MathType::FLEX,
        }
    }
}

impl BinaryExpression {
    fn math_type(&self) -> Option<MathType> {
        let lhs = self.lhs.math_type()?;
        let rhs = self.rhs.math_type()?;
        match self.operation {
            BinaryOperation::Add | BinaryOperation::Subtract => lhs.add(rhs),
            BinaryOperation::Multiply => lhs.multiply(rhs),
            BinaryOperation::Divide => lhs.divide(rhs),
        }
    }
}

impl MathFunction {
    fn math_type(&self) -> Option<MathType> {
        match self {
            Self::Calc(value) | Self::Abs(value) => value.math_type(),
            Self::Sign(_) => Some(MathType::NUMBER),
            Self::Min(values) | Self::Max(values) | Self::Hypot(values) => uniform_type(values),
            Self::Clamp(value) => value.math_type(),
            Self::Round(value) => value.math_type(),
            Self::Mod(value) | Self::Rem(value) => value.same_type(),
            Self::Sin(value) | Self::Cos(value) | Self::Tan(value)
                if value.math_type()?.is_number() || value.math_type()?.is_angle() =>
            {
                Some(MathType::NUMBER)
            }
            Self::Sin(_) | Self::Cos(_) | Self::Tan(_) => None,
            Self::Asin(value) | Self::Acos(value) | Self::Atan(value)
                if value.math_type()?.is_number() =>
            {
                Some(MathType::ANGLE)
            }
            Self::Asin(_) | Self::Acos(_) | Self::Atan(_) => None,
            Self::Atan2(value) if value.same_type().is_some() => Some(MathType::ANGLE),
            Self::Atan2(_) => None,
            Self::Pow(value) if value.both_are(MathType::NUMBER) => Some(MathType::NUMBER),
            Self::Pow(_) => None,
            Self::Sqrt(value) | Self::Exp(value) if value.math_type()?.is_number() => {
                Some(MathType::NUMBER)
            }
            Self::Sqrt(_) | Self::Exp(_) => None,
            Self::Log(value)
                if value.value.math_type()?.is_number()
                    && value
                        .base
                        .as_ref()
                        .is_none_or(|base| base.math_type().is_some_and(MathType::is_number)) =>
            {
                Some(MathType::NUMBER)
            }
            Self::Log(_) => None,
        }
    }

    fn contains_percentage(&self) -> bool {
        match self {
            Self::Calc(value)
            | Self::Abs(value)
            | Self::Sign(value)
            | Self::Sin(value)
            | Self::Cos(value)
            | Self::Tan(value)
            | Self::Asin(value)
            | Self::Acos(value)
            | Self::Atan(value)
            | Self::Sqrt(value)
            | Self::Exp(value) => value.contains_percentage(),
            Self::Min(values) | Self::Max(values) | Self::Hypot(values) => {
                values.iter().any(MathExpression::contains_percentage)
            }
            Self::Clamp(value) => {
                value
                    .minimum
                    .as_ref()
                    .is_some_and(MathExpression::contains_percentage)
                    || value.preferred.contains_percentage()
                    || value
                        .maximum
                        .as_ref()
                        .is_some_and(MathExpression::contains_percentage)
            }
            Self::Round(value) => {
                value.value.contains_percentage()
                    || value
                        .interval
                        .as_ref()
                        .is_some_and(MathExpression::contains_percentage)
            }
            Self::Mod(value) | Self::Rem(value) | Self::Atan2(value) | Self::Pow(value) => {
                value.contains_percentage()
            }
            Self::Log(value) => {
                value.value.contains_percentage()
                    || value
                        .base
                        .as_ref()
                        .is_some_and(MathExpression::contains_percentage)
            }
        }
    }
}

impl PairExpression {
    fn same_type(&self) -> Option<MathType> {
        same_type(self.first.math_type()?, self.second.math_type()?)
    }

    fn both_are(&self, expected: MathType) -> bool {
        self.first.math_type() == Some(expected) && self.second.math_type() == Some(expected)
    }

    fn contains_percentage(&self) -> bool {
        self.first.contains_percentage() || self.second.contains_percentage()
    }
}

impl ClampExpression {
    fn math_type(&self) -> Option<MathType> {
        let result = self.preferred.math_type()?;
        let result = match &self.minimum {
            Some(minimum) => same_type(minimum.math_type()?, result)?,
            None => result,
        };
        match &self.maximum {
            Some(maximum) => same_type(result, maximum.math_type()?),
            None => Some(result),
        }
    }
}

impl RoundExpression {
    fn math_type(&self) -> Option<MathType> {
        let value_type = self.value.math_type()?;
        match &self.interval {
            Some(interval) => same_type(value_type, interval.math_type()?),
            None => value_type.is_number().then_some(MathType::NUMBER),
        }
    }
}

fn uniform_type(values: &[MathExpression]) -> Option<MathType> {
    let mut values = values.iter();
    let result = values.next()?.math_type()?;
    values.try_fold(result, |result, value| {
        same_type(result, value.math_type()?)
    })
}

fn same_type(lhs: MathType, rhs: MathType) -> Option<MathType> {
    lhs.add(rhs)
}
