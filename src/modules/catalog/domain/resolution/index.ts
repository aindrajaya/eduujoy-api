export { type Candidate, clampSimilarity, type Decision, decide } from './decide';
export { type Domain, MAX_RELATED, type Neighbour, pickRelated, RELATED_FLOOR, relatedCandidates } from './related';
export { fallbackTopicName, normaliseTopicText, queryText, slugify, topicDocument, type TopicDocumentSource } from './text';
export { CHOICE_THRESHOLD, MATCH_MARGIN, MATCH_THRESHOLD, MAX_CHOICES } from './thresholds';
