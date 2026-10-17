import type * as Persisted from "./session-entries";

export type {
	SessionEntryBase,
	SessionMessageEntry,
	ServiceTierChangeEntry,
	BranchSummaryEntry,
	CustomMessageEntry,
	CustomEntry,
	LabelEntry,
	TitleChangeEntry,
	TtsrInjectionEntry,
	ModeChangeEntry,
	ResetBoundaryEntry,
} from "./session-entries";

/** Exact engine views of the richer persisted records. */
export type ThinkingLevelChangeEntry = Omit<Persisted.ThinkingLevelChangeEntry, "configured">;
export type ModelChangeEntry = Omit<Persisted.ModelChangeEntry, "resolvedModelIsFallback">;
export type CompactionEntry<T = unknown> = Omit<Persisted.CompactionEntry<T>, "tokensAfter" | "method">;
export type SessionInitEntry = Pick<
	Persisted.SessionInitEntry,
	keyof Persisted.SessionEntryBase | "systemPrompt" | "task" | "tools" | "outputSchema"
>;

export interface CustomCompactionSessionEntries {}

export type SessionEntry =
	| Persisted.SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| Persisted.ServiceTierChangeEntry
	| CompactionEntry
	| Persisted.BranchSummaryEntry
	| Persisted.CustomEntry
	| Persisted.CustomMessageEntry
	| Persisted.LabelEntry
	| Persisted.TitleChangeEntry
	| Persisted.TtsrInjectionEntry
	| SessionInitEntry
	| Persisted.ModeChangeEntry
	| Persisted.ResetBoundaryEntry
	| CustomCompactionSessionEntries[keyof CustomCompactionSessionEntries];

export interface ReadonlySessionManager {
	getBranch(leafId?: string | null): SessionEntry[];
	getEntry(id: string): SessionEntry | undefined;
}
