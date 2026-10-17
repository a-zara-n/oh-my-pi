import type { ImageContent, Message, MessageAttribution, ProviderPayload, TextContent } from "./model-data";
/**
 * Truncation metadata for the output notice.
 */
export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	/** Line range shown (1-indexed, inclusive). Omitted for middle elision. */
	shownRange?: { start: number; end: number };
	/** Head/tail line ranges shown when direction === "middle". */
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	/** Bytes elided from the middle. */
	elidedBytes?: number;
	/** Lines elided from the middle. */
	elidedLines?: number;
	/** Artifact ID if full output was saved */
	artifactId?: string;
	/** Bytes the artifact cap dropped from the saved file's middle; the artifact is then a head/tail sample. */
	artifactElidedBytes?: number;
	/** Next offset for pagination (head truncation only) */
	nextOffset?: number;
	/**
	 * The single shown line is a byte-capped preview of one oversized line, not
	 * a complete line. `outputBytes`/`totalBytes` are the preview vs full line
	 * size; renders a distinct "partial" notice instead of a line range.
	 */
	partialLine?: boolean;
}

/**
 * Source resolution info for the output.
 */
export type SourceMeta =
	| { type: "path"; value: string }
	| { type: "url"; value: string }
	| { type: "internal"; value: string }
	/** A complete aggregate report, whose entries may contain incomplete source captures. */
	| { type: "report"; value: string };

/**
 * LSP diagnostic info (for edit/write tools).
 */
export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}

/**
 * Limit-specific notices.
 */
export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	/** `suggestion` is omitted when the tool is already at its hard cap, so no larger usable limit exists to advise. */
	resultLimit?: { reached: number; suggestion?: number };
	headLimit?: { reached: number; suggestion: number };
	/** `unit` may be absent in sessions persisted before it was recorded. */
	columnTruncated?: { maxColumn: number; unit?: "bytes" | "chars"; artifactId?: string; artifactElidedBytes?: number };
}

/**
 * Structured metadata for tool outputs.
 */
export interface OutputMeta {
	truncation?: TruncationMeta;
	/** Capture failure of this output itself; aggregate reports keep source failures on their entries. */
	artifactError?: OutputArtifactError;
	source?: SourceMeta;
	/** The output is a bounded page of session artifact storage its `source` re-reads with line selectors; spill-to-artifact skips it. */
	pagedSource?: true;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
}
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	/** Estimated context tokens after the rewrite (display metadata). */
	tokensAfter?: number;
	/** Harness compaction method that produced this summary (display metadata). */
	method?: string;
	providerPayload?: ProviderPayload;
	/** Runtime-only ordered archive blocks for snapcompact: old text region,
	 *  imaged middle, then new text region. When present, `summary` is already
	 *  the final lead-in text (no legacy wrapper applied). */
	blocks?: (TextContent | ImageContent)[];
	/** Snapcompact image blocks, kept for display counts / legacy consumers. */
	images?: ImageContent[];
	/** Post-pass dead-end warning attached to this compaction (progress guard). */
	warning?: string;
	/**
	 * Thinking-binding rewrite marker when it must differ from `timestamp`: a
	 * natively replayed summary predates it before the retained tail so that
	 * tail's bound thinking stays valid. `timestamp` remains the commit time,
	 * which is what invalidates the tail's pre-compaction usage reports.
	 */
	historyRewriteAt?: number;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;
/** Content shape accepted for extension-injected messages. */
export type CustomMessageContent = string | (TextContent | ImageContent)[];

/** Public input accepted by `pi.sendMessage` and `AgentSession.sendCustomMessage`. */
export type CustomMessagePayload<T = unknown> =
	| string
	| Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">>;

/** Custom message payload after applying runtime defaults. */
export type NormalizedCustomMessagePayload<T = unknown> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details" | "attribution"
>;
/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	/** Images extracted from terminal graphics in the command's stdout. */
	images?: ImageContent[];
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for user-initiated Python executions via the $ command.
 * Shares the same kernel session as eval's Python backend.
 */
export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context ($ prefix) */
	excludeFromContext?: boolean;
}
/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}>;
	timestamp: number;
}
/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@oh-my-pi/pi-utils/agent-messages" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	bashExecution: BashExecutionMessage;
	pythonExecution: PythonExecutionMessage;
	custom: CustomMessage;
	hookMessage: HookMessage;
	branchSummary: BranchSummaryMessage;
	compactionSummary: CompactionSummaryMessage;
	fileMention: FileMentionMessage;
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
/** First failed artifact I/O operation; safe to persist without exposing filesystem errors. */
export type OutputArtifactError = "open" | "write" | "flush" | "end";
