use std::{borrow::Cow, collections::HashMap};

use crate::parser::css::{CssMathExpression, CssValue, StyleMap};

pub(super) struct ComputedDeclarations<'a> {
    values: Cow<'a, StyleMap>,
}

impl<'a> ComputedDeclarations<'a> {
    pub(super) fn substitute_math(
        specified: &'a StyleMap,
        custom_properties: &HashMap<String, String>,
    ) -> Self {
        let pending = specified
            .properties
            .iter()
            .filter_map(|(property, value)| match value {
                CssValue::PendingMath(expression) => {
                    Some((property.clone(), expression.source().to_string()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Self {
                values: Cow::Borrowed(specified),
            };
        }

        let mut values = specified.clone();
        for (property, source) in pending {
            let expression =
                crate::style::resolve::resolve_vars_in_value(&source, custom_properties)
                    .and_then(|resolved| CssMathExpression::parse(&resolved));
            match expression {
                Some(expression) => {
                    values
                        .properties
                        .insert(property, CssValue::Math(expression));
                }
                None => values.remove(&property),
            }
        }
        Self {
            values: Cow::Owned(values),
        }
    }

    pub(super) fn as_style_map(&self) -> &StyleMap {
        &self.values
    }
}
