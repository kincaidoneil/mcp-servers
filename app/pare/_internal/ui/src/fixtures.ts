// Sample sessions for the harness and the E2E tests. Fictional senders and
// tasks; the shapes are what an agent would send to pare-start.

import type { SessionConfigInput } from "../../schema";

const newsletterItems: SessionConfigInput["items"] = [
  {
    id: "nl-1",
    title: "The Weekly Ledger",
    subtitle: "ledger@example-finance.com · every Sunday",
    body: 'Markets recap and three charts. You opened one issue in the last six months.\n\nMost recent subject: "Why the yield curve is boring again".',
    meta: [
      { label: "Received", value: "52 in the last year" },
      { label: "Last opened", value: "7 months ago" },
    ],
    suggestion: { action: "dispose", reason: "Rarely opened" },
  },
  {
    id: "nl-2",
    title: "Type Foundry Dispatch",
    subtitle: "hello@foundry.example · monthly",
    body: "New typeface releases, licensing notes, and one long interview per issue. You forwarded two of these to colleagues.",
    meta: [
      { label: "Received", value: "12 in the last year" },
      { label: "Last opened", value: "3 days ago" },
    ],
    suggestion: { action: "keep", reason: "Opened most issues" },
  },
  {
    id: "nl-3",
    title: "Daily Deal Blast",
    subtitle: "deals@megastore.example · daily",
    body: "Promotions, coupons, and a countdown timer that is always at 02:59:59.",
    meta: [
      { label: "Received", value: "361 in the last year" },
      { label: "Last opened", value: "never" },
    ],
    suggestion: { action: "dispose", reason: "Never opened, 361 sends" },
  },
  {
    id: "nl-4",
    title: "Trail Conditions Report",
    subtitle: "alerts@ridgeparks.example · weekly in season",
    body: "Closures, snowpack, and washouts for the ridge trails. Short, factual, no images.",
    meta: [
      { label: "Received", value: "26 in the last year" },
      { label: "Last opened", value: "2 weeks ago" },
    ],
    suggestion: { action: "keep", reason: "Actionable and seasonal" },
  },
  {
    id: "nl-5",
    title: "Product Update: Q3 Highlights",
    subtitle: "noreply@saas-tool.example · quarterly",
    body: "You cancelled this subscription in 2024. The company still sends quarterly roundups of features you do not use.\n\nThis issue covers a new pricing tier, an AI assistant, and a redesigned billing page.",
    meta: [
      { label: "Received", value: "4 in the last year" },
      { label: "Last opened", value: "never" },
    ],
    suggestion: { action: "dispose", reason: "No longer a customer" },
  },
  {
    id: "nl-6",
    title: "Long Reads Sunday",
    subtitle: "editor@longreads.example · weekly",
    body: "Five essays with one-paragraph summaries. Average issue length is about 1,400 words before the links.\n\nYou opened 30 of the last 52 issues and clicked through on 11. The most-clicked topics were urban planning, biography, and the history of computing. Issues arrive at 6am on Sundays and are generally read on the same day.\n\nThe publisher moved to a paid tier last spring; you are on the free edition, which now carries two sponsored placements per issue.",
    meta: [
      { label: "Received", value: "52 in the last year" },
      { label: "Last opened", value: "yesterday" },
      { label: "Click-through", value: "21%" },
    ],
    suggestion: { action: "keep", reason: "Read most weeks" },
  },
  {
    id: "nl-7",
    title: "Webinar Invitations",
    subtitle: "events@vendor.example · several per week",
    body: "Invitations to vendor webinars, each with three reminder emails.",
    meta: [
      { label: "Received", value: "118 in the last year" },
      { label: "Last opened", value: "never" },
    ],
    suggestion: { action: "dispose", reason: "Reminders triple the volume" },
  },
  {
    id: "nl-8",
    title: "Neighborhood Association Notes",
    subtitle: "board@elmstreet.example · monthly",
    body: "Meeting minutes, street sweeping schedule, and the occasional lost cat.",
    meta: [
      { label: "Received", value: "11 in the last year" },
      { label: "Last opened", value: "1 month ago" },
    ],
    url: "https://example.com/elmstreet",
  },
  {
    id: "nl-9",
    title: "Hardware Teardowns",
    subtitle: "teardown@circuits.example · biweekly",
    body: "Photos and notes from taking consumer devices apart. Long, image-heavy, and you scroll to the end most times.",
    meta: [
      { label: "Received", value: "26 in the last year" },
      { label: "Last opened", value: "5 days ago" },
    ],
    suggestion: { action: "keep" },
  },
  {
    id: "nl-10",
    title: "Recruiter Digest",
    subtitle: "digest@talent-network.example · weekly",
    body: "Roles that match keywords in a profile you have not updated since 2022.",
    meta: [
      { label: "Received", value: "50 in the last year" },
      { label: "Last opened", value: "9 months ago" },
    ],
    suggestion: { action: "dispose", reason: "Stale profile" },
  },
  {
    id: "nl-11",
    title: "Coffee Roaster Updates",
    subtitle: "beans@smallroast.example · when a new lot lands",
    body: "One paragraph per new lot with tasting notes. You ordered from three of the last eight.",
    meta: [
      { label: "Received", value: "8 in the last year" },
      { label: "Orders placed", value: "3" },
    ],
    suggestion: { action: "keep", reason: "You order from it" },
  },
  {
    id: "nl-12",
    title: "Security Advisories",
    subtitle: "advisories@oss-project.example · as needed",
    body: "CVE notices for a library you depend on in two projects.",
    meta: [
      { label: "Received", value: "6 in the last year" },
      { label: "Last opened", value: "3 weeks ago" },
    ],
    suggestion: { action: "keep", reason: "Operationally relevant" },
  },
];

const taskItems: SessionConfigInput["items"] = [
  {
    id: "t-1",
    title: "Renew passport",
    subtitle: "Admin · added 14 months ago",
    body: "Expires next March. Renewal by mail takes 6 to 8 weeks.",
    meta: [{ label: "Due", value: "none" }],
    suggestion: { action: "keep", reason: "Hard deadline approaching" },
  },
  {
    id: "t-2",
    title: "Read the Rust book",
    subtitle: "Learning · added 2 years ago",
    body: "Sat in the backlog through two spring cleanings.",
    suggestion: { action: "dispose", reason: "Two years untouched" },
  },
  {
    id: "t-3",
    title: "Fix the porch light",
    subtitle: "Home · added 3 weeks ago",
    body: "Sensor stopped triggering. Probably the photocell.",
    suggestion: { action: "later", reason: "Needs a daylight visit" },
  },
  {
    id: "t-4",
    title: "Write up the migration retro",
    subtitle: "Work · added 5 days ago",
    body: "Team asked for it before the next planning session.",
    suggestion: { action: "keep" },
  },
  {
    id: "t-5",
    title: "Compare insurance quotes",
    subtitle: "Finance · added 8 months ago",
    body: "Renewal already happened. The next window is in April.",
    suggestion: { action: "later", reason: "Out of window" },
  },
  {
    id: "t-6",
    title: "Send the vendor the signed contract",
    subtitle: "Work · added 2 days ago",
    body: "Legal returned it yesterday. Ops can send it.",
    suggestion: { action: "delegate", reason: "Ops owns vendor paperwork" },
  },
];

export const FIXTURES: Record<string, SessionConfigInput> = {
  newsletters: {
    title: "Newsletter subscriptions",
    description: "Unsubscribe from the ones you no longer read.",
    keep: { label: "Stay subscribed", hint: "Leave this subscription alone" },
    dispose: { label: "Unsubscribe", hint: "Unsubscribe and archive past issues" },
    items: newsletterItems,
  },
  tasks: {
    title: "Backlog review",
    description: "Every task older than a week. Keep, drop, or park it.",
    keep: { label: "Keep" },
    dispose: { label: "Drop", hint: "Delete the task" },
    extra_actions: [
      { id: "later", label: "Someday", hint: "Move to the someday list" },
      { id: "delegate", label: "Delegate", hint: "Hand it to someone else" },
    ],
    items: taskItems,
  },
  terse: {
    title: "Quick pass",
    notes: false,
    skip: false,
    items: [
      { id: "q-1", title: "First" },
      { id: "q-2", title: "Second" },
      { id: "q-3", title: "Third" },
    ],
  },
};
