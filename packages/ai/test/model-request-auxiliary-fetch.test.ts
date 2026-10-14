import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { markNextModelRequestAttempt, runWithModelRequestLineage } from "@oh-my-pi/pi-ai/model-request-execution";
import { ModelRequestDeniedError } from "@oh-my-pi/pi-ai/model-request-gate";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { clearAwsCredentialCache, resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { createBedrockMantleAuthenticatedFetch } from "@oh-my-pi/pi-ai/providers/bedrock-mantle";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import {
	clearGitLabDuoDirectAccessCache,
	getGitLabDuoModels,
	streamGitLabDuo,
} from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import {
	type GitLabDuoWorkflowWebSocketFactory,
	type GitLabDuoWorkflowWebSocketLike,
	streamGitLabDuoWorkflow,
} from "@oh-my-pi/pi-ai/providers/gitlab-duo-workflow";
import { __resetVertexTokenCache, getVertexAccessToken } from "@oh-my-pi/pi-ai/providers/google-auth";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AssignModelResponseSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
	ModelAssignmentSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import * as geminiHeaders from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { withEnv } from "./helpers";
import { BEDROCK_TEST_CONTEXT, bedrockHappyPathFrames, bedrockTestModel } from "./helpers/bedrock-stream";
import { installFixtureGate, type RecordingLease, recordingLease } from "./helpers/model-request-gate-fixture";
import {
	anthropicTextReply,
	type LoopbackReply,
	loopbackModel,
	openAICompletionsTextReply,
	replyBody,
} from "./helpers/model-request-loopback";

/**
 * A provider receives ONE gated `options.fetch` for its model request. Its credential exchanges, metadata lookups,
 * version probes and setup calls ride the same transport but are not model requests: the registered gate must never be
 * asked about them, never be shown their bodies or responses, and the real model request that follows in the same
 * logical request must be a `first` attempt rather than a retry of the lookup.
 */

const gate = installFixtureGate();

const INFERENCE_URL = "https://inference.test/v1/chat/completions";
const INFERENCE_REQUEST_BODY = JSON.stringify({ prompt: "the real model request" });
const INFERENCE_REPLY = "the real model reply";
const DENIAL_MESSAGE = "denied by the test gate";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface SeenRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: Uint8Array;
}

/** A scripted answer for one request the base transport received; `undefined` answers 404. */
type Responder = (request: SeenRequest) => Response | undefined;

async function bodyBytes(input: string | URL | Request, init: RequestInit | undefined): Promise<Uint8Array> {
	const body = init?.body;
	if (body === undefined || body === null) {
		return input instanceof Request ? new Uint8Array(await input.clone().arrayBuffer()) : new Uint8Array();
	}
	if (typeof body === "string") return encoder.encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (body instanceof URLSearchParams) return encoder.encode(body.toString());
	throw new TypeError("the test transport does not know this request body type");
}

async function describeRequest(input: string | URL | Request, init: RequestInit | undefined): Promise<SeenRequest> {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
	return {
		url: input instanceof Request ? input.url : input.toString(),
		method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
		headers,
		body: await bodyBytes(input, init),
	};
}

function responseOf(reply: LoopbackReply): Response {
	return new Response(replyBody(reply), { status: reply.status, headers: reply.headers });
}

interface Harness {
	/** Every request that reached the base transport, in order. */
	readonly seen: SeenRequest[];
	/** One recording lease per attempt the gate allowed. */
	readonly leases: RecordingLease[];
	/** The transport a caller of a provider hands in: what the core's own `transportFetch` builds around `base`. */
	readonly base: FetchImpl;
	readonly gated: FetchImpl;
}

/** A gate that allows every attempt it is asked about, under a fresh recording lease, and a fake transport behind it. */
function harness(model: Model<Api>, respond: Responder): Harness {
	const seen: SeenRequest[] = [];
	const leases: RecordingLease[] = [];
	const base: FetchImpl = async (input, init) => {
		const request = await describeRequest(input, init);
		seen.push(request);
		if (request.url === INFERENCE_URL) return new Response(INFERENCE_REPLY);
		return respond(request) ?? new Response("unexpected request", { status: 404 });
	};
	gate.setHandler(async () => {
		const lease = recordingLease();
		leases.push(lease);
		return { type: "allow", lease: lease.lease };
	});
	return { seen, leases, base, gated: transportFetch(model, base) };
}

/** The model request of the helper-level scenarios: a plain POST through the gated fetch. */
async function sendInference(fetchImpl: FetchImpl): Promise<void> {
	const response = await fetchImpl(INFERENCE_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: INFERENCE_REQUEST_BODY,
	});
	expect(await response.text()).toBe(INFERENCE_REPLY);
}

/** Resolve a provider run into success or a thrown error that carries the failed message as its cause. */
async function succeeded(message: Promise<AssistantMessage>): Promise<void> {
	const result = await message;
	if (result.stopReason === "error")
		throw new Error(result.errorMessage ?? "the provider run failed", { cause: result });
}

const textContext: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const inferenceModel = loopbackModel("openai-completions", "https://inference.test");

interface Scenario {
	readonly name: string;
	readonly model: Model<Api>;
	/** Substrings of the auxiliary request URLs the helper must send before its model request. */
	readonly auxiliary: readonly string[];
	/** Values that appear only in auxiliary requests or responses and must never reach the gate. */
	readonly leaks: readonly string[];
	isInference(url: string): boolean;
	respond: Responder;
	/** Prepare files and spies under `tmp`; returns the environment the run needs. */
	arrange(tmp: string): Promise<Record<string, string | undefined>>;
	/** Run the helper, then its model request, through `harness.gated` (or `harness.base` for a core entry). */
	run(harness: Harness): Promise<void>;
}

let tmpDir: string;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auxiliary-fetch-"));
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
	gate.reset();
	__resetVertexTokenCache();
	clearAwsCredentialCache();
	clearGitLabDuoDirectAccessCache();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	gate.reset();
	__resetVertexTokenCache();
	clearAwsCredentialCache();
	clearGitLabDuoDirectAccessCache();
});

/** No host ADC: the run falls through to the metadata server unless the scenario writes an ADC file. */
function withoutHostAdc(): void {
	const homedir = spyOn(os, "homedir").mockReturnValue(path.join(tmpDir, "no-adc-home"));
	cleanups.push(() => homedir.mockRestore());
}

function googleEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
	return {
		GOOGLE_CLOUD_ACCESS_TOKEN: undefined,
		CLOUDSDK_AUTH_ACCESS_TOKEN: undefined,
		GOOGLE_CLOUD_API_KEY: undefined,
		GOOGLE_APPLICATION_CREDENTIALS: undefined,
		GOOGLE_CLOUD_PROJECT: undefined,
		GCP_PROJECT: undefined,
		GCLOUD_PROJECT: undefined,
		GOOGLE_VERTEX_LOCATION: undefined,
		GOOGLE_CLOUD_LOCATION: undefined,
		VERTEX_LOCATION: undefined,
		...extra,
	};
}

const AWS_ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_SDK_LOAD_CONFIG",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
	"AWS_ROLE_SESSION_NAME",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_SKIP_AUTH",
] as const;

/** Every AWS variable cleared, empty shared config files, then `extra`. */
async function awsEnv(extra: Record<string, string>): Promise<Record<string, string | undefined>> {
	const credentials = path.join(tmpDir, "aws-credentials");
	const config = path.join(tmpDir, "aws-config");
	await Promise.all([Bun.write(credentials, ""), Bun.write(config, "")]);
	return {
		...Object.fromEntries(AWS_ENV_KEYS.map(key => [key, undefined])),
		AWS_SHARED_CREDENTIALS_FILE: credentials,
		AWS_CONFIG_FILE: config,
		AWS_EC2_METADATA_DISABLED: "true",
		...extra,
	};
}

async function writeAdc(name: string, adc: Record<string, unknown>): Promise<string> {
	const file = path.join(tmpDir, name);
	await Bun.write(file, JSON.stringify(adc));
	return file;
}

/** A real RS256 key so the service-account JWT signing runs for real. */
async function generateServiceAccountPem(): Promise<string> {
	const keyPair = (await globalThis.crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
	const body = (
		Buffer.from(pkcs8)
			.toString("base64")
			.match(/.{1,64}/g) ?? []
	).join("\n");
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Google ADC / metadata-server token exchange (google-auth.ts), reached directly and through the Vertex entries.
// ---------------------------------------------------------------------------------------------------------------------

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const IAM_URL_PREFIX = "https://iamcredentials.googleapis.com/";
const GOOGLE_ACCESS_TOKEN = "google-access-token-secret-4411";
const GOOGLE_CLIENT_SECRET = "google-client-secret-4412";
const GOOGLE_REFRESH_TOKEN = "google-refresh-token-secret-4413";
const GOOGLE_IMPERSONATED_TOKEN = "google-impersonated-token-secret-4414";

function googleTokenResponder(request: SeenRequest): Response | undefined {
	if (request.url === OAUTH_TOKEN_URL || request.url === METADATA_TOKEN_URL) {
		return Response.json({ access_token: GOOGLE_ACCESS_TOKEN, expires_in: 3600 });
	}
	if (request.url.startsWith(IAM_URL_PREFIX)) {
		return Response.json({
			accessToken: GOOGLE_IMPERSONATED_TOKEN,
			expireTime: new Date(Date.now() + 3_600_000).toISOString(),
		});
	}
	return undefined;
}

const AUTHORIZED_USER = {
	type: "authorized_user",
	client_id: "client-id",
	client_secret: GOOGLE_CLIENT_SECRET,
	refresh_token: GOOGLE_REFRESH_TOKEN,
};

const googleAuthScenarios: readonly Scenario[] = [
	{
		name: "google-auth getVertexAccessToken: authorized_user refresh-token exchange",
		model: inferenceModel,
		auxiliary: [OAUTH_TOKEN_URL],
		leaks: [GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_ACCESS_TOKEN],
		isInference: url => url === INFERENCE_URL,
		respond: googleTokenResponder,
		arrange: async () =>
			googleEnv({ GOOGLE_APPLICATION_CREDENTIALS: await writeAdc("adc-user.json", AUTHORIZED_USER) }),
		run: async h => {
			expect(await getVertexAccessToken({ fetch: h.gated })).toBe(GOOGLE_ACCESS_TOKEN);
			await sendInference(h.gated);
		},
	},
	{
		name: "google-auth getVertexAccessToken: service-account JWT assertion exchange",
		model: inferenceModel,
		auxiliary: [OAUTH_TOKEN_URL],
		leaks: [GOOGLE_ACCESS_TOKEN, "service-account-key-id-4415"],
		isInference: url => url === INFERENCE_URL,
		respond: googleTokenResponder,
		arrange: async () =>
			googleEnv({
				GOOGLE_APPLICATION_CREDENTIALS: await writeAdc("adc-service-account.json", {
					type: "service_account",
					client_email: "source@project.iam.gserviceaccount.com",
					private_key: await generateServiceAccountPem(),
					private_key_id: "service-account-key-id-4415",
				}),
			}),
		run: async h => {
			expect(await getVertexAccessToken({ fetch: h.gated })).toBe(GOOGLE_ACCESS_TOKEN);
			await sendInference(h.gated);
		},
	},
	{
		name: "google-auth getVertexAccessToken: service-account impersonation",
		model: inferenceModel,
		auxiliary: [OAUTH_TOKEN_URL, IAM_URL_PREFIX],
		leaks: [GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_ACCESS_TOKEN, GOOGLE_IMPERSONATED_TOKEN],
		isInference: url => url === INFERENCE_URL,
		respond: googleTokenResponder,
		arrange: async () =>
			googleEnv({
				GOOGLE_APPLICATION_CREDENTIALS: await writeAdc("adc-impersonated.json", {
					type: "impersonated_service_account",
					service_account_impersonation_url: `${IAM_URL_PREFIX}v1/projects/-/serviceAccounts/target@project.iam.gserviceaccount.com:generateAccessToken`,
					source_credentials: AUTHORIZED_USER,
				}),
			}),
		run: async h => {
			expect(await getVertexAccessToken({ fetch: h.gated })).toBe(GOOGLE_IMPERSONATED_TOKEN);
			await sendInference(h.gated);
		},
	},
	{
		name: "google-auth getVertexAccessToken: metadata-server token",
		model: inferenceModel,
		auxiliary: [METADATA_TOKEN_URL],
		leaks: [GOOGLE_ACCESS_TOKEN],
		isInference: url => url === INFERENCE_URL,
		respond: googleTokenResponder,
		arrange: async () => {
			withoutHostAdc();
			return googleEnv();
		},
		run: async h => {
			expect(await getVertexAccessToken({ fetch: h.gated })).toBe(GOOGLE_ACCESS_TOKEN);
			await sendInference(h.gated);
		},
	},
];

const vertexGeminiModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3.1-pro-preview",
	name: "Gemini 3.1 Pro Preview",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "https://{location}-aiplatform.googleapis.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

const vertexAnthropicModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4@20250514",
	name: "Claude Sonnet 4",
	api: "anthropic-messages",
	provider: "google-vertex",
	baseUrl:
		"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

function vertexGeminiResponder(request: SeenRequest): Response | undefined {
	if (request.url.includes(":streamGenerateContent")) {
		const event = {
			candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		};
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return googleTokenResponder(request);
}

const vertexScenarios: readonly Scenario[] = [
	{
		name: "google-vertex provider: metadata-server token before :streamGenerateContent",
		model: vertexGeminiModel,
		auxiliary: [METADATA_TOKEN_URL],
		leaks: [GOOGLE_ACCESS_TOKEN],
		isInference: url => url.includes(":streamGenerateContent"),
		respond: vertexGeminiResponder,
		arrange: async () => {
			withoutHostAdc();
			return googleEnv();
		},
		run: h =>
			succeeded(
				streamGoogleVertex(vertexGeminiModel, textContext, {
					project: "vertex-project",
					location: "us-central1",
					fetch: h.gated,
				}).result(),
			),
	},
	{
		name: "google-vertex provider: ADC refresh-token exchange before :streamGenerateContent",
		model: vertexGeminiModel,
		auxiliary: [OAUTH_TOKEN_URL],
		leaks: [GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_ACCESS_TOKEN],
		isInference: url => url.includes(":streamGenerateContent"),
		respond: vertexGeminiResponder,
		arrange: async () =>
			googleEnv({ GOOGLE_APPLICATION_CREDENTIALS: await writeAdc("adc-vertex-user.json", AUTHORIZED_USER) }),
		run: h =>
			succeeded(
				streamGoogleVertex(vertexGeminiModel, textContext, {
					project: "vertex-project",
					location: "us-central1",
					fetch: h.gated,
				}).result(),
			),
	},
	{
		name: "stream() on a Vertex Anthropic model (createVertexAuthenticatedFetch): token before :streamRawPredict",
		model: vertexAnthropicModel,
		auxiliary: [METADATA_TOKEN_URL],
		leaks: [GOOGLE_ACCESS_TOKEN],
		isInference: url => url.includes(":streamRawPredict"),
		respond: request =>
			request.url.includes(":streamRawPredict")
				? responseOf(anthropicTextReply("hi"))
				: googleTokenResponder(request),
		arrange: async () => {
			withoutHostAdc();
			return googleEnv({ GOOGLE_CLOUD_PROJECT: "vertex-project", GOOGLE_VERTEX_LOCATION: "us-central1" });
		},
		// The core entry builds the gated transport itself from the base transport.
		run: h =>
			succeeded(stream(vertexAnthropicModel, textContext, { apiKey: "<authenticated>", fetch: h.base }).result()),
	},
];

// ---------------------------------------------------------------------------------------------------------------------
// GitLab Duo: direct_access exchange (gitlab-duo.ts) and the REST setup calls of the workflow provider.
// ---------------------------------------------------------------------------------------------------------------------

const GITLAB_ACCOUNT_TOKEN = "gitlab-account-token-secret-5511";
const GITLAB_DIRECT_TOKEN = "gitlab-direct-access-token-secret-5512";
const GITLAB_RAILS_TOKEN = "gitlab-rails-token-secret-5513";
const DIRECT_ACCESS_URL = "https://gitlab.com/api/v4/ai/third_party_agents/direct_access";
const GITLAB_PROXY_COMPLETIONS_URL = "https://cloud.gitlab.com/ai/v1/proxy/openai/v1/chat/completions";

const gitlabDuoModel = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-gpt-5-1");
if (!gitlabDuoModel) throw new Error("the GitLab Duo OpenAI-routed catalog model is missing");

const gitlabDuoScenario: Scenario = {
	name: "gitlab-duo provider: direct_access exchange before the proxied model request",
	model: gitlabDuoModel,
	auxiliary: [DIRECT_ACCESS_URL],
	leaks: [GITLAB_ACCOUNT_TOKEN],
	isInference: url => url === GITLAB_PROXY_COMPLETIONS_URL,
	respond: request => {
		if (request.url === DIRECT_ACCESS_URL) return Response.json({ token: GITLAB_DIRECT_TOKEN, headers: {} });
		if (request.url === GITLAB_PROXY_COMPLETIONS_URL) return responseOf(openAICompletionsTextReply("hi"));
		return undefined;
	},
	arrange: async () => ({}),
	run: h =>
		succeeded(
			streamGitLabDuo(gitlabDuoModel, textContext, { apiKey: GITLAB_ACCOUNT_TOKEN, fetch: h.gated }).result(),
		),
};

const GITLAB_WORKFLOW_TOKEN = "gitlab-workflow-account-token-secret-5514";
const workflowModel: Model<"gitlab-duo-agent"> = buildModel({
	id: "claude_sonnet_4_6_vertex",
	name: "Claude Sonnet 4.6 - Vertex",
	api: "gitlab-duo-agent",
	provider: "gitlab-duo-agent",
	baseUrl: "https://gitlab.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
	supportsTools: true,
});

function workflowRestResponder(request: SeenRequest): Response | undefined {
	if (request.url.includes("/api/graphql")) {
		return Response.json({
			data: {
				aiChatAvailableModels: {
					defaultModel: { name: "Claude", ref: "claude_sonnet_4_6_vertex" },
					selectableModels: [],
					pinnedModel: null,
				},
			},
		});
	}
	if (request.url.includes("/api/v4/ai/duo_workflows/direct_access")) {
		return Response.json({ gitlab_rails: { token: GITLAB_RAILS_TOKEN } });
	}
	if (request.url.includes("/api/v4/ai/duo_workflows/workflows/")) return Response.json({});
	if (request.url.includes("/api/v4/ai/duo_workflows/workflows") && request.method === "POST") {
		return Response.json({ id: "workflow-1" });
	}
	if (/\/api\/v4\/groups\/[^/]+$/.test(request.url.split("?")[0] ?? request.url)) return Response.json({});
	return undefined;
}

function inputRequiredSocket(): GitLabDuoWorkflowWebSocketFactory {
	return () => {
		const socket: GitLabDuoWorkflowWebSocketLike = {
			onopen: null,
			onmessage: null,
			onerror: null,
			onclose: null,
			send() {},
			close() {},
		};
		queueMicrotask(() => {
			socket.onopen?.(new Event("open"));
			socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ status: "INPUT_REQUIRED" }) }));
		});
		return socket;
	};
}

const gitlabWorkflowScenario: Scenario = {
	name: "gitlab-duo-workflow provider: REST setup calls (settings, models, direct_access, create)",
	model: workflowModel,
	auxiliary: ["/api/graphql", "/api/v4/ai/duo_workflows/direct_access", "/api/v4/ai/duo_workflows/workflows"],
	leaks: [GITLAB_WORKFLOW_TOKEN, GITLAB_RAILS_TOKEN],
	isInference: url => url === INFERENCE_URL,
	respond: workflowRestResponder,
	arrange: async () => ({}),
	run: async h => {
		await succeeded(
			streamGitLabDuoWorkflow(workflowModel, textContext, {
				apiKey: GITLAB_WORKFLOW_TOKEN,
				rootNamespaceId: "gid://gitlab/Group/77",
				fetch: h.gated,
				webSocketFactory: inputRequiredSocket(),
			}).result(),
		);
		// The workflow's own model request is not a fetch; the next fetch-borne model request is still the first.
		await sendInference(h.gated);
	},
};

// ---------------------------------------------------------------------------------------------------------------------
// Devin: auth metadata and model assignment before the chat message.
// ---------------------------------------------------------------------------------------------------------------------

const DEVIN_KEY = "devin-api-key-secret-6611";
const DEVIN_USER_JWT = "devin-user-jwt-secret-6612";

function connectFrame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	new DataView(out.buffer).setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

const DEVIN_ASSIGN_MODEL_URL_PART = "/exa.api_server_pb.ApiServerService/AssignModel";
const DEVIN_GET_USER_JWT_URL_PART = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_CHAT_URL_PART = "/exa.api_server_pb.ApiServerService/GetChatMessage";

function devinTestModel(router: boolean): Model<"devin-agent"> {
	return buildModel({
		id: router ? "devin-router-test" : "devin-auxiliary-test",
		name: router ? "Devin Router Test" : "Devin Auxiliary Test",
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://server.codeium.com",
		...(router ? { requestModelId: "adaptive" } : {}),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat: { modelRouter: router },
	});
}

/** The provider's three answers: the user JWT, a router assignment, and a one-message chat reply. */
function devinResponder(request: SeenRequest): Response {
	if (request.url.includes("GetUserJwt")) {
		return new Response(
			toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: DEVIN_USER_JWT })),
		);
	}
	if (request.url.includes("AssignModel")) {
		const assignment = create(ModelAssignmentSchema, { assignmentJwt: "assign-jwt", modelUid: "claude-sonnet-4-5" });
		return new Response(toBinary(AssignModelResponseSchema, create(AssignModelResponseSchema, { assignment })));
	}
	const chat = create(GetChatMessageResponseSchema, { messageId: "msg-1", stopReason: StopReason.STOP_PATTERN });
	return new Response(connectFrame(toBinary(GetChatMessageResponseSchema, chat)));
}

const devinModel = devinTestModel(false);
const devinRouterModel = devinTestModel(true);

const devinScenario: Scenario = {
	name: "devin provider: GetUserJwt before GetChatMessage",
	model: devinModel,
	auxiliary: [DEVIN_GET_USER_JWT_URL_PART],
	leaks: [],
	isInference: url => url.endsWith(DEVIN_CHAT_URL_PART),
	respond: devinResponder,
	arrange: async () => ({}),
	run: h => succeeded(streamDevin(devinModel, textContext, { apiKey: DEVIN_KEY, fetch: h.gated }).result()),
};

// ---------------------------------------------------------------------------------------------------------------------
// Google Antigravity (gemini-cli provider): client-version manifest lookup before the Cloud Code request.
// ---------------------------------------------------------------------------------------------------------------------

const ANTIGRAVITY_ACCESS_TOKEN = "antigravity-access-token-secret-7711";
const ANTIGRAVITY_MANIFEST = "latest-arm64-mac.yml";
const ANTIGRAVITY_MANIFEST_URL = `https://antigravity-updates.test/manifest/${ANTIGRAVITY_MANIFEST}`;
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const antigravityScenario: Scenario = {
	name: "google-gemini-cli provider (Antigravity): version manifest lookup before :streamGenerateContent",
	model: antigravityModel,
	auxiliary: [ANTIGRAVITY_MANIFEST],
	leaks: [],
	isInference: url => url.includes(":streamGenerateContent"),
	respond: request => {
		if (request.url.includes(ANTIGRAVITY_MANIFEST)) return new Response("unavailable", { status: 404 });
		if (request.url.includes(":streamGenerateContent")) {
			const event = { response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] } };
			return new Response(`data: ${JSON.stringify(event)}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return undefined;
	},
	arrange: async () => {
		// The real lookup keeps process-wide state (a success, or a failure that is not retried for ten minutes), so it
		// cannot be made to run on demand. Stand in for it with a lookup that sends its manifest request through the
		// fetch the provider hands over, which is the one thing this scenario is about.
		const lookup = spyOn(geminiHeaders, "ensureAntigravityVersion").mockImplementation(async fetcher => {
			await fetcher?.(ANTIGRAVITY_MANIFEST_URL, { headers: { "Cache-Control": "no-cache" } });
		});
		cleanups.push(() => lookup.mockRestore());
		return {};
	},
	run: h =>
		succeeded(
			streamGoogleGeminiCli(antigravityModel, textContext, {
				apiKey: JSON.stringify({ token: ANTIGRAVITY_ACCESS_TOKEN, projectId: "proj-123" }),
				fetch: h.gated,
			}).result(),
		),
};

// ---------------------------------------------------------------------------------------------------------------------
// AWS credential chain (aws-credentials.ts), reached directly, through Bedrock Converse and through Bedrock Mantle.
// ---------------------------------------------------------------------------------------------------------------------

const AWS_SECRET_KEY = "aws-secret-access-key-secret-8811";
const AWS_SESSION_TOKEN = "aws-session-token-secret-8812";
const AWS_CONTAINER_AUTH = "aws-container-auth-secret-8813";
const AWS_WEB_IDENTITY = "aws-web-identity-token-secret-8814";
const CONTAINER_CREDENTIALS_URL = "http://169.254.170.2/v2/credentials/test";
const IMDS_BASE_URL = "http://imds.internal:8181/";
const STS_HOST = "sts.us-east-1.amazonaws.com";

function dynamicCredentialsJson(): Response {
	return Response.json({
		AccessKeyId: "AKIAAUXILIARY",
		SecretAccessKey: AWS_SECRET_KEY,
		Token: AWS_SESSION_TOKEN,
		Expiration: "2099-01-01T00:00:00Z",
	});
}

const containerEnv = (): Promise<Record<string, string | undefined>> =>
	awsEnv({
		AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/test",
		AWS_CONTAINER_AUTHORIZATION_TOKEN: AWS_CONTAINER_AUTH,
	});

const bedrockConverseScenario: Scenario = {
	name: "amazon-bedrock provider: ECS container credentials before converse-stream",
	model: bedrockTestModel(),
	auxiliary: [CONTAINER_CREDENTIALS_URL],
	leaks: [AWS_CONTAINER_AUTH, AWS_SECRET_KEY, AWS_SESSION_TOKEN],
	isInference: url => url.includes("converse-stream"),
	respond: request => {
		if (request.url === CONTAINER_CREDENTIALS_URL) return dynamicCredentialsJson();
		if (request.url.includes("converse-stream")) {
			return new Response(Buffer.concat(bedrockHappyPathFrames()), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		}
		return undefined;
	},
	arrange: containerEnv,
	run: h =>
		succeeded(
			streamBedrock(bedrockTestModel(), BEDROCK_TEST_CONTEXT, { region: "us-east-1", fetch: h.gated }).result(),
		),
};

const bedrockMantleScenario: Scenario = {
	name: "bedrock-mantle createBedrockMantleAuthenticatedFetch: ECS container credentials before the signed request",
	model: inferenceModel,
	auxiliary: [CONTAINER_CREDENTIALS_URL],
	leaks: [AWS_CONTAINER_AUTH, AWS_SECRET_KEY, AWS_SESSION_TOKEN],
	isInference: url => url === INFERENCE_URL,
	respond: request => (request.url === CONTAINER_CREDENTIALS_URL ? dynamicCredentialsJson() : undefined),
	arrange: containerEnv,
	run: async h => {
		const signed = createBedrockMantleAuthenticatedFetch({
			fetch: h.gated,
			providerOptions: { region: "us-east-1" },
		});
		await sendInference(signed);
	},
};

const awsCredentialScenarios: readonly Scenario[] = [
	{
		name: "aws-credentials resolveAwsCredentials: ECS container credential endpoint",
		model: inferenceModel,
		auxiliary: [CONTAINER_CREDENTIALS_URL],
		leaks: [AWS_CONTAINER_AUTH, AWS_SECRET_KEY, AWS_SESSION_TOKEN],
		isInference: url => url === INFERENCE_URL,
		respond: request => (request.url === CONTAINER_CREDENTIALS_URL ? dynamicCredentialsJson() : undefined),
		arrange: containerEnv,
		run: async h => {
			const credentials = await resolveAwsCredentials({ region: "us-east-1", fetch: h.gated });
			expect(credentials.secretAccessKey).toBe(AWS_SECRET_KEY);
			await sendInference(h.gated);
		},
	},
	{
		name: "aws-credentials resolveAwsCredentials: EC2 IMDSv2",
		model: inferenceModel,
		auxiliary: [`${IMDS_BASE_URL}latest/api/token`, `${IMDS_BASE_URL}latest/meta-data/iam/security-credentials/`],
		leaks: [AWS_SECRET_KEY, AWS_SESSION_TOKEN, "imds-session-token-secret-8815"],
		isInference: url => url === INFERENCE_URL,
		respond: request => {
			if (request.url.endsWith("/latest/api/token")) return new Response("imds-session-token-secret-8815");
			if (request.url.endsWith("/latest/meta-data/iam/security-credentials/")) return new Response("test-role");
			if (request.url.includes("/latest/meta-data/iam/security-credentials/test-role"))
				return dynamicCredentialsJson();
			return undefined;
		},
		arrange: () => awsEnv({ AWS_EC2_METADATA_DISABLED: "false", AWS_EC2_METADATA_SERVICE_ENDPOINT: IMDS_BASE_URL }),
		run: async h => {
			const credentials = await resolveAwsCredentials({ region: "us-east-1", fetch: h.gated });
			expect(credentials.secretAccessKey).toBe(AWS_SECRET_KEY);
			await sendInference(h.gated);
		},
	},
	{
		name: "aws-credentials resolveAwsCredentials: STS web-identity exchange",
		model: inferenceModel,
		auxiliary: [STS_HOST],
		leaks: [AWS_WEB_IDENTITY, AWS_SECRET_KEY, AWS_SESSION_TOKEN],
		isInference: url => url === INFERENCE_URL,
		respond: request => {
			if (!request.url.includes(STS_HOST)) return undefined;
			return new Response(
				`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
					<AccessKeyId>AKIAAUXILIARY</AccessKeyId><SecretAccessKey>${AWS_SECRET_KEY}</SecretAccessKey>
					<SessionToken>${AWS_SESSION_TOKEN}</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>
				</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
				{ headers: { "content-type": "text/xml" } },
			);
		},
		arrange: async () => {
			const tokenFile = path.join(tmpDir, "web-identity-token");
			await Bun.write(tokenFile, `${AWS_WEB_IDENTITY}\n`);
			return awsEnv({
				AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
				AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test-role",
				AWS_ROLE_SESSION_NAME: "test-session",
			});
		},
		run: async h => {
			const credentials = await resolveAwsCredentials({ region: "us-east-1", fetch: h.gated });
			expect(credentials.secretAccessKey).toBe(AWS_SECRET_KEY);
			await sendInference(h.gated);
		},
	},
];

const SCENARIOS: readonly Scenario[] = [
	...googleAuthScenarios,
	...vertexScenarios,
	gitlabDuoScenario,
	gitlabWorkflowScenario,
	devinScenario,
	antigravityScenario,
	bedrockConverseScenario,
	bedrockMantleScenario,
	...awsCredentialScenarios,
];

// ---------------------------------------------------------------------------------------------------------------------

function textOf(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

async function expectOnlyTheModelRequestWasGated(h: Harness, scenario: Scenario): Promise<void> {
	// The gate was asked about exactly one attempt, and it is the model request, a first attempt.
	expect(gate.attempts).toHaveLength(1);
	const attempt = gate.attempts[0]!;
	expect(attempt.kind).toBe("chat");
	expect(attempt.reason).toBe("first");
	expect(attempt.retryOf).toBeUndefined();
	const wire = attempt.wire;
	if (wire === undefined) throw new Error("expected the model request to carry a readable wire");
	expect(scenario.isInference(wire.url)).toBe(true);

	// Every auxiliary request reached its endpoint through the transport, before the model request.
	const inferenceIndex = h.seen.findIndex(request => scenario.isInference(request.url));
	expect(inferenceIndex).toBeGreaterThanOrEqual(0);
	for (const fragment of scenario.auxiliary) {
		const index = h.seen.findIndex(request => request.url.includes(fragment));
		expect(index).toBeGreaterThanOrEqual(0);
		expect(index).toBeLessThan(inferenceIndex);
	}

	// The only lease is the model request's; it observed the model reply and nothing of the auxiliary exchange.
	expect(h.leases).toHaveLength(1);
	const observed = textOf(h.leases[0]!.observedBytes());
	expect(observed.length).toBeGreaterThan(0);
	const body = textOf(await wire.readBody());
	const headers = Object.values(wire.headers).join("\n");
	for (const leak of scenario.leaks) {
		expect(wire.url).not.toContain(leak);
		expect(headers).not.toContain(leak);
		expect(body).not.toContain(leak);
		expect(observed).not.toContain(leak);
	}
}

describe("auxiliary requests bypass the model request gate", () => {
	test("control: a request sent straight through the gated fetch is shown to the gate", async () => {
		const h = harness(inferenceModel, () => undefined);

		await runWithModelRequestLineage(() => sendInference(h.gated));

		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.wire?.url).toBe(INFERENCE_URL);
	});

	for (const scenario of SCENARIOS) {
		describe(scenario.name, () => {
			test("the gate is asked for the model request only, which is a first attempt, never a retry of the lookup", async () => {
				await withEnv(await scenario.arrange(tmpDir), async () => {
					const h = harness(scenario.model, scenario.respond);

					await runWithModelRequestLineage(() => scenario.run(h));

					await expectOnlyTheModelRequestWasGated(h, scenario);
				});
			});

			test("a gate denial of the model request is surfaced as the denial, after the lookup succeeded, with one attempt asked", async () => {
				await withEnv(await scenario.arrange(tmpDir), async () => {
					const h = harness(scenario.model, scenario.respond);
					gate.setHandler(async () => ({ type: "deny", code: "test-denied", message: DENIAL_MESSAGE }));

					const error = await runWithModelRequestLineage(() => scenario.run(h)).then(
						() => undefined,
						(thrown: unknown) => thrown,
					);

					expect(error).toBeDefined();
					expect(AIError.isModelRequestDenied(error)).toBe(true);
					expect(error).not.toBeInstanceOf(AIError.MissingApiKeyError);
					// The lookup was not turned into a missing credential: it ran and the model request was the only ask.
					expect(gate.attempts).toHaveLength(1);
					expect(scenario.isInference(gate.attempts[0]?.wire?.url ?? "")).toBe(true);
					for (const fragment of scenario.auxiliary) {
						expect(h.seen.some(request => request.url.includes(fragment))).toBe(true);
					}
					expect(h.seen.some(request => scenario.isInference(request.url))).toBe(false);
					expect(h.leases).toHaveLength(0);
				});
			});
		});
	}
});

describe("a gate denial raised inside a credential lookup is surfaced, never swallowed as no credential", () => {
	const denial = new ModelRequestDeniedError("test-denied", DENIAL_MESSAGE);
	const denying: FetchImpl = async () => {
		throw denial;
	};

	test("google-auth: the metadata-server lookup rethrows the denial", async () => {
		await withEnv(googleEnv(), async () => {
			withoutHostAdc();

			const error = await getVertexAccessToken({ fetch: denying }).catch((thrown: unknown) => thrown);

			expect(error).toBe(denial);
		});
	});

	test("google-auth: an ordinary metadata-server failure still means no credential", async () => {
		await withEnv(googleEnv(), async () => {
			withoutHostAdc();
			const unreachable: FetchImpl = async () => {
				throw new Error("connection refused");
			};

			const error = await getVertexAccessToken({ fetch: unreachable }).catch((thrown: unknown) => thrown);

			expect(error).toBeInstanceOf(AIError.MissingApiKeyError);
		});
	});

	test("aws-credentials: the IMDS lookup rethrows the denial", async () => {
		await withEnv(await awsEnv({ AWS_EC2_METADATA_DISABLED: "false" }), async () => {
			const error = await resolveAwsCredentials({ region: "us-east-1", fetch: denying }).catch(
				(thrown: unknown) => thrown,
			);

			expect(error).toBe(denial);
		});
	});

	test("aws-credentials: an ordinary IMDS failure still means no credential", async () => {
		await withEnv(await awsEnv({ AWS_EC2_METADATA_DISABLED: "false" }), async () => {
			const unreachable: FetchImpl = async () => {
				throw new Error("connection refused");
			};

			const error = await resolveAwsCredentials({ region: "us-east-1", fetch: unreachable }).catch(
				(thrown: unknown) => thrown,
			);

			expect(error).toBeInstanceOf(AIError.AwsCredentialsError);
		});
	});

	test("gitlab-duo-workflow: a denial from the model catalog lookup stops the run instead of falling back to defaults", async () => {
		let socketOpened = false;
		const catalogDenied: FetchImpl = async (input, init) => {
			const request = await describeRequest(input, init);
			if (request.url.includes("/api/graphql")) throw denial;
			return workflowRestResponder(request) ?? new Response("unexpected request", { status: 404 });
		};
		const factory = inputRequiredSocket();

		const result = await streamGitLabDuoWorkflow(workflowModel, textContext, {
			apiKey: GITLAB_WORKFLOW_TOKEN,
			rootNamespaceId: "gid://gitlab/Group/77",
			fetch: catalogDenied,
			webSocketFactory: (url, options) => {
				socketOpened = true;
				return factory(url, options);
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(DENIAL_MESSAGE);
		expect(socketOpened).toBe(false);
	});
});

describe("devin router assignment is a model request: it carries the user's prompt", () => {
	const routerRun = (h: Harness) =>
		succeeded(streamDevin(devinRouterModel, textContext, { apiKey: DEVIN_KEY, fetch: h.gated }).result());

	test("the gate is asked about AssignModel and then about the chat message, each a first attempt of its own; only GetUserJwt skips it", async () => {
		const h = harness(devinRouterModel, devinResponder);

		await runWithModelRequestLineage(() => routerRun(h));

		expect(h.seen.map(request => request.url.slice(request.url.indexOf("/exa.")))).toEqual([
			DEVIN_GET_USER_JWT_URL_PART,
			DEVIN_ASSIGN_MODEL_URL_PART,
			DEVIN_CHAT_URL_PART,
		]);
		expect(gate.attempts).toHaveLength(2);
		const [assign, chat] = gate.attempts;
		expect(assign?.wire?.url.endsWith(DEVIN_ASSIGN_MODEL_URL_PART)).toBe(true);
		expect(chat?.wire?.url.endsWith(DEVIN_CHAT_URL_PART)).toBe(true);
		for (const attempt of gate.attempts) {
			expect(attempt.kind).toBe("chat");
			expect(attempt.reason).toBe("first");
			expect(attempt.retryOf).toBeUndefined();
		}
		expect(assign?.requestId).not.toBe(chat?.requestId);
		expect(h.leases).toHaveLength(2);
		// The user's JWT comes from the lookup that is not a model request and never appears on the gate's side.
		for (const lease of h.leases) expect(textOf(lease.observedBytes())).not.toContain(DEVIN_USER_JWT);
		for (const attempt of gate.attempts) {
			expect(Object.values(attempt.wire?.headers ?? {}).join("\n")).not.toContain(DEVIN_USER_JWT);
		}
	});

	test("a gate that refuses AssignModel sends nothing of the turn: no AssignModel, no chat message, the denial is surfaced", async () => {
		const h = harness(devinRouterModel, devinResponder);
		gate.setHandler(async () => ({ type: "deny", code: "test-denied", message: DENIAL_MESSAGE }));

		const error = await runWithModelRequestLineage(() => routerRun(h)).then(
			() => undefined,
			(thrown: unknown) => thrown,
		);

		expect(AIError.isModelRequestDenied(error)).toBe(true);
		expect(gate.attempts).toHaveLength(1);
		expect(gate.attempts[0]?.wire?.url.endsWith(DEVIN_ASSIGN_MODEL_URL_PART)).toBe(true);
		// Only the credential lookup reached the provider.
		expect(h.seen.map(request => request.url.slice(request.url.indexOf("/exa.")))).toEqual([
			DEVIN_GET_USER_JWT_URL_PART,
		]);
		expect(h.leases).toHaveLength(0);
	});

	test("a gate that allows AssignModel and refuses the chat message stops the turn at the chat message", async () => {
		const h = harness(devinRouterModel, devinResponder);
		gate.setHandler(async attempt => {
			if (attempt.wire?.url.endsWith(DEVIN_CHAT_URL_PART)) {
				return { type: "deny", code: "test-denied", message: DENIAL_MESSAGE };
			}
			const lease = recordingLease();
			h.leases.push(lease);
			return { type: "allow", lease: lease.lease };
		});

		const error = await runWithModelRequestLineage(() => routerRun(h)).then(
			() => undefined,
			(thrown: unknown) => thrown,
		);

		expect(AIError.isModelRequestDenied(error)).toBe(true);
		expect(gate.attempts.map(attempt => attempt.wire?.url.slice(attempt.wire.url.indexOf("/exa.")))).toEqual([
			DEVIN_ASSIGN_MODEL_URL_PART,
			DEVIN_CHAT_URL_PART,
		]);
		expect(h.seen.some(request => request.url.endsWith(DEVIN_CHAT_URL_PART))).toBe(false);
	});

	test("the reason a retrying caller declared for the next attempt stays with the chat message, not the assignment", async () => {
		const h = harness(devinRouterModel, devinResponder);

		await runWithModelRequestLineage(() => {
			markNextModelRequestAttempt("auth-rotation");
			return routerRun(h);
		});

		expect(gate.attempts.map(attempt => attempt.reason)).toEqual(["first", "auth-rotation"]);
	});
});
