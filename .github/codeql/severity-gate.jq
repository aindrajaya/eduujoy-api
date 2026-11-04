# One line per unsuppressed result whose rule has security-severity >= 4.0: rule, severity, file:line.
# Rules live in the driver or in a tool extension (query packs); severity is a string property.
.runs[] as $run
| ([$run.tool.driver.rules[]?, ($run.tool.extensions[]?.rules[]?)]
    | map({ key: .id, value: ((.properties["security-severity"] // "0") | tonumber) })
    | from_entries) as $sev
| $run.results[]?
| select(((.suppressions // []) | length) == 0)
| (.ruleId // .rule.id) as $rule
| select(($sev[$rule] // 0) >= 4.0)
| "\($rule)\t\($sev[$rule])\t\(.locations[0].physicalLocation.artifactLocation.uri // "?"):\(.locations[0].physicalLocation.region.startLine // "?")"
