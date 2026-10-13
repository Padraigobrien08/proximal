// Learning sessions and independent review checkpoints. Server enforces phase, ordinal and eligibility.
// Barrel: the implementation lives in ./sessions/, one module per area. Only the public API is re-exported.
export { MAX_CHECKPOINT_QUESTIONS, DEFAULT_CHECKPOINT_QUESTIONS } from "./sessions/shared";
export { modeForPurpose, startSession, summariseSession, type StartSessionInput } from "./sessions/start";
export { feedbackVisible, feedbackView, type FeedbackView, type AttemptView } from "./sessions/helpers";
export { getSessionView, type SessionView } from "./sessions/view";
export { submitAnswer, retryAttemptAssessment, releaseCheckpointFeedback, type SubmitAnswerInput, type SubmitResult } from "./sessions/answers";
export { reveal, type RevealInput } from "./sessions/reveal";
export { endSession, advanceLearning, demoExamplesFor } from "./sessions/lifecycle";
