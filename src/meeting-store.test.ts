import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteMeeting, getMeeting, listMeetings, saveMeeting, type Meeting } from "./meeting-store.js";

describe("meeting-store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hypatia-meetings-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const meeting: Meeting = {
		id: "m1",
		title: "Standup",
		createdAt: "2026-01-01T00:00:00.000Z",
		transcript: "hello world",
	};

	it("returns [] when no meetings directory exists", () => {
		expect(listMeetings(dir)).toEqual([]);
	});

	it("persists and reads back a meeting", () => {
		saveMeeting(dir, meeting);
		expect(getMeeting(dir, "m1")).toEqual(meeting);
		expect(listMeetings(dir)).toEqual([meeting]);
	});

	it("lists meetings newest-first", () => {
		saveMeeting(dir, { ...meeting, id: "old", createdAt: "2026-01-01T00:00:00.000Z" });
		saveMeeting(dir, { ...meeting, id: "new", createdAt: "2026-01-02T00:00:00.000Z" });

		expect(listMeetings(dir).map((m) => m.id)).toEqual(["new", "old"]);
	});

	it("overwrites a meeting saved again with the same id", () => {
		saveMeeting(dir, meeting);
		saveMeeting(dir, { ...meeting, summary: "recap" });

		expect(getMeeting(dir, "m1")?.summary).toBe("recap");
		expect(listMeetings(dir)).toHaveLength(1);
	});

	it("deletes a meeting by id", () => {
		saveMeeting(dir, meeting);
		expect(deleteMeeting(dir, "m1")).toBe(true);
		expect(getMeeting(dir, "m1")).toBeUndefined();
	});

	it("deleting an unknown id is a no-op that returns false", () => {
		expect(deleteMeeting(dir, "missing")).toBe(false);
	});

	it("getMeeting returns undefined for an unknown id", () => {
		expect(getMeeting(dir, "missing")).toBeUndefined();
	});
});
