/**
 * meeting-store — persistence for recorded meetings ("Record Meeting").
 *
 * One JSON file per meeting under `<hypatiaAgentDir>/meetings/<id>.json`,
 * mirroring mcp-connector-store.ts's shape but per-file rather than a single
 * whole-file list (transcripts can get long; no reason to rewrite every
 * other meeting's JSON on every save).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Meeting {
	id: string;
	title: string;
	createdAt: string;
	transcript: string;
	summary?: string;
	/** Which summarization template produced `summary` (see handlers/meetings.ts's SUMMARY_TEMPLATES). */
	summaryTemplate?: string;
}

function meetingsDir(agentDir: string): string {
	return join(agentDir, "meetings");
}

function meetingFilePath(agentDir: string, id: string): string {
	return join(meetingsDir(agentDir), `${id}.json`);
}

export function listMeetings(agentDir: string): Meeting[] {
	const dir = meetingsDir(agentDir);
	if (!existsSync(dir)) return [];
	const meetings: Meeting[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(dir, entry), "utf-8"));
			if (parsed && typeof parsed === "object") meetings.push(parsed as Meeting);
		} catch {
			// skip corrupt file
		}
	}
	meetings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return meetings;
}

export function getMeeting(agentDir: string, id: string): Meeting | undefined {
	const fp = meetingFilePath(agentDir, id);
	if (!existsSync(fp)) return undefined;
	try {
		return JSON.parse(readFileSync(fp, "utf-8")) as Meeting;
	} catch {
		return undefined;
	}
}

export function saveMeeting(agentDir: string, meeting: Meeting): Meeting {
	mkdirSync(meetingsDir(agentDir), { recursive: true });
	writeFileSync(meetingFilePath(agentDir, meeting.id), JSON.stringify(meeting, null, 2), "utf-8");
	return meeting;
}

export function deleteMeeting(agentDir: string, id: string): boolean {
	const fp = meetingFilePath(agentDir, id);
	if (!existsSync(fp)) return false;
	unlinkSync(fp);
	return true;
}
