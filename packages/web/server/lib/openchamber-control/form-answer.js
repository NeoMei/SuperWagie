const isFiniteNumber = Number.isFinite;
const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
const isBoolean = (value) => value === true || value === false;
const defaultOf = (field) => {
    switch (field.type) {
        case 'string':
            return isText(field.default) && field.default.trim() ? field.default : undefined;
        case 'number':
        case 'integer':
            return isFiniteNumber(field.default) ? field.default : undefined;
        case 'boolean':
            return isBoolean(field.default) ? field.default : false;
        case 'multiselect':
            return Array.isArray(field.default) && field.default.length > 0 ? [...field.default] : undefined;
        default:
            return undefined;
    }
};
const clauseMatches = (clause, answer) => {
    if (answer === undefined)
        return false;
    const hit = Array.isArray(answer) ? answer.some((entry) => entry === clause.value) : answer === clause.value;
    return clause.op === 'eq' ? hit : !hit;
};
export const completeFormAnswer = (fields, values) => {
    const answer = {};
    const formFields = Array.isArray(fields) ? fields : [];
    for (const field of formFields) {
        if (!field || !isText(field.key))
            continue;
        const given = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
        if (field.type === 'external') {
            if (given !== undefined)
                answer[field.key] = given;
            continue;
        }
        if (!(field.when ?? []).every((clause) => clauseMatches(clause, answer[clause.key])))
            continue;
        const value = given !== undefined ? given : defaultOf(field);
        if (value !== undefined)
            answer[field.key] = value;
    }
    return answer;
};
