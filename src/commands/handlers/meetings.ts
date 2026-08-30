/**
 * Meeting recording command handlers ("Record Meeting"): start/stream/stop
 * capture, save/summarize/list/get/delete persisted meetings.
 *
 * Recording is a single global in-memory session (no multi-recording
 * concurrency in v1) — same "module-level singleton state" convention
 * mcp-oauth.ts already uses for its one-login-attempt-at-a-time state.
 */

import { randomUUID } from "node:crypto";
import { send, log, logWarn } from "../../protocol.js";
import type { HandlerDependencies } from "../handler-registry.js";
import { hypatiaAgentDir, loadSettings } from "../../agent-init.js";
import { deleteMeeting, getMeeting, listMeetings, saveMeeting, type Meeting } from "../../meeting-store.js";
import { createOpenAiTranscriber, type Transcriber } from "../../meeting/openai-transcriber.js";
import { createAwsTranscriber } from "../../meeting/aws-transcriber.js";
import type {
	StartMeetingRecordingCommand,
	MeetingAudioChunkCommand,
	StopMeetingRecordingCommand,
	SaveMeetingCommand,
	SummarizeMeetingCommand,
	ListMeetingsCommand,
	GetMeetingCommand,
	DeleteMeetingCommand,
} from "../types.js";

interface ActiveRecording {
	transcriber: Transcriber;
	segments: string[];
}

let activeRecording: ActiveRecording | undefined;

function emitTranscript(text: string, isFinal: boolean): void {
	send({ type: "event", event: { kind: "meeting_transcript", text, isFinal } });
}

export async function handleStartMeetingRecording(
	deps: HandlerDependencies,
	cmd: StartMeetingRecordingCommand,
): Promise<void> {
	if (activeRecording) {
		send({ type: "error", id: cmd.id, message: "a recording is already in progress" });
		return;
	}
	const settings = loadSettings(deps.hypatiaDir) as Record<string, unknown>;
	const provider = settings.transcriptionProvider === "aws" ? "aws" : "openai";
	const sampleRate = 16_000;

	const segments: string[] = [];
	const onTranscript = (text: string, isFinal: boolean) => {
		if (isFinal) segments.push(text);
		emitTranscript(text, isFinal);
	};

	try {
		const transcriber: Transcriber =
			provider === "aws"
				? createAwsTranscriber({
						accessKeyId: String(settings.awsAccessKeyId ?? ""),
						secretAccessKey: String(settings.awsSecretAccessKey ?? ""),
						region: String(settings.awsRegion ?? "us-east-1"),
						sampleRate,
						onTranscript,
					})
				: createOpenAiTranscriber({
						apiKey: String(settings.openaiApiKey ?? ""),
						sampleRate,
						onTranscript,
					});
		activeRecording = { transcriber, segments };
		log("meeting recording started (provider=%s)", provider);
		send({ type: "result", id: cmd.id, data: { success: true, provider } });
	} catch (err) {
		send({ type: "error", id: cmd.id, message: err instanceof Error ? err.message : String(err) });
	}
}

export async function handleMeetingAudioChunk(
	_deps: HandlerDependencies,
	cmd: MeetingAudioChunkCommand,
): Promise<void> {
	if (!activeRecording) return;
	try {
		const pcm = Buffer.from(cmd.data, "base64");
		activeRecording.transcriber.pushChunk(pcm);
	} catch (err) {
		logWarn("meeting_audio_chunk: failed to push chunk: %s", err instanceof Error ? err.message : String(err));
	}
}

export async function handleStopMeetingRecording(
	_deps: HandlerDependencies,
	cmd: StopMeetingRecordingCommand,
): Promise<void> {
	const recording = activeRecording;
	activeRecording = undefined;
	if (!recording) {
		send({ type: "result", id: cmd.id, data: { transcript: "" } });
		return;
	}
	try {
		await recording.transcriber.stop();
	} catch (err) {
		logWarn("stop_meeting_recording: transcriber.stop() failed: %s", err instanceof Error ? err.message : String(err));
	}
	send({ type: "result", id: cmd.id, data: { transcript: recording.segments.join(" ") } });
}

export async function handleSaveMeeting(deps: HandlerDependencies, cmd: SaveMeetingCommand): Promise<void> {
	try {
		const agentDir = hypatiaAgentDir(deps.hypatiaDir);
		const existing = cmd.meetingId ? getMeeting(agentDir, cmd.meetingId) : undefined;
		const meeting: Meeting = {
			id: cmd.meetingId ?? randomUUID(),
			title: cmd.title,
			createdAt: existing?.createdAt ?? new Date().toISOString(),
			transcript: cmd.transcript,
			summary: existing?.summary,
		};
		saveMeeting(agentDir, meeting);
		send({ type: "result", id: cmd.id, data: { meeting } });
	} catch (err) {
		send({ type: "error", id: cmd.id, message: err instanceof Error ? err.message : String(err) });
	}
}

/**
 * Summary styles the user can pick after a recording ends (see
 * MeetingsPanel's template-picker screen). Each maps to a system prompt
 * that shapes the model's markdown output differently — the frontend just
 * renders whatever markdown comes back, no structured parsing.
 */
export const SUMMARY_TEMPLATES: Record<string, { name: string; prompt: string }> = {
	general: {
		name: "General Notes",
		prompt:
			"Summarize this meeting transcript for someone who didn't attend. Write a short markdown recap: a one-paragraph overview, then a '## Key Points' bulleted list of what was discussed. Be concise — no full retelling.",
	},
	action: {
		name: "Action Items",
		prompt:
			"Extract the action items from this meeting transcript as markdown. Output a '## Action Items' section with one bullet per task, bold the owner's name where the transcript identifies one (e.g. '**Priya** — draft the roadmap doc — Fri'), and note the deadline if mentioned. Skip anything that isn't a concrete task. If no owner or deadline was stated, omit that part rather than guessing.",
	},
	decision: {
		name: "Decision Log",
		prompt:
			"Extract the decisions made in this meeting transcript as markdown. Output a '## Decisions' section; for each decision use a bold one-line statement of the decision followed by a short line explaining why it was made, based only on the transcript. Skip anything that was merely discussed but not decided.",
	},
	sales: {
		name: "Sales Call",
		prompt:
			"Summarize this sales/customer call transcript as markdown with two sections: '## Pain Points' (problems or frustrations the customer raised) and '## Next Steps' (agreed follow-ups, bulleted). Be concise and only include what the transcript actually supports.",
	},
};

const DEFAULT_TEMPLATE = "general";

export async function handleSummarizeMeeting(
	deps: HandlerDependencies,
	cmd: SummarizeMeetingCommand,
): Promise<void> {
	if (!deps.modelRegistry || !deps.modelRuntime) {
		send({ type: "error", id: cmd.id, message: "Not initialized" });
		return;
	}
	try {
		const agentDir = hypatiaAgentDir(deps.hypatiaDir);
		const meeting = getMeeting(agentDir, cmd.meetingId);
		if (!meeting) {
			send({ type: "error", id: cmd.id, message: "meeting not found" });
			return;
		}
		const model = deps.session?.model ?? (await deps.modelRegistry.getAvailable())[0];
		if (!model) {
			send({ type: "error", id: cmd.id, message: "no model available to summarize with" });
			return;
		}
		const templateId = cmd.template && SUMMARY_TEMPLATES[cmd.template] ? cmd.template : DEFAULT_TEMPLATE;
		const result = await deps.modelRuntime.completeSimple(model, {
			systemPrompt: SUMMARY_TEMPLATES[templateId].prompt,
			messages: [{ role: "user", content: meeting.transcript }],
		});
		const summary = typeof result?.text === "string" ? result.text : JSON.stringify(result);
		const updated: Meeting = { ...meeting, summary, summaryTemplate: templateId };
		saveMeeting(agentDir, updated);
		send({ type: "result", id: cmd.id, data: { meeting: updated } });
	} catch (err) {
		send({ type: "error", id: cmd.id, message: err instanceof Error ? err.message : String(err) });
	}
}

export async function handleListMeetings(deps: HandlerDependencies, cmd: ListMeetingsCommand): Promise<void> {
	const agentDir = hypatiaAgentDir(deps.hypatiaDir);
	send({ type: "result", id: cmd.id, data: { meetings: listMeetings(agentDir) } });
}

export async function handleGetMeeting(deps: HandlerDependencies, cmd: GetMeetingCommand): Promise<void> {
	const agentDir = hypatiaAgentDir(deps.hypatiaDir);
	const meeting = getMeeting(agentDir, cmd.meetingId);
	if (!meeting) {
		send({ type: "error", id: cmd.id, message: "meeting not found" });
		return;
	}
	send({ type: "result", id: cmd.id, data: { meeting } });
}

export async function handleDeleteMeeting(deps: HandlerDependencies, cmd: DeleteMeetingCommand): Promise<void> {
	const agentDir = hypatiaAgentDir(deps.hypatiaDir);
	send({ type: "result", id: cmd.id, data: { deleted: deleteMeeting(agentDir, cmd.meetingId) } });
}
