/**
 * Virtual-model stream projection and execution, delegated to `@earendil-works/pi-ai/virtual-models`.
 */
export {
	anchorAnthropicCacheBeforeEphemeralTail,
	applyRequiredToolChoicePayload,
	buildRoutedStreamOptions,
	type ExecuteRoutedStreamParams,
	executeRoutedStream,
	type PhysicalStreamDispatcher,
	projectRoutedTranscript,
	type RoutedStreamCompletion,
	type SidecarUsageRecorder,
} from "@earendil-works/pi-ai/virtual-models";
