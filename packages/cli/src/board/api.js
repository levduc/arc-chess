// Plan 5 Task 2 placeholder: Task 3 replaces this with the fetch/SSE client. Browsers cannot set headers on
// EventSource, so the real client reads GET /events with fetch() (an Authorization header and x-arena-actor:
// human) and a ReadableStream reader, not the EventSource API.
export {};
