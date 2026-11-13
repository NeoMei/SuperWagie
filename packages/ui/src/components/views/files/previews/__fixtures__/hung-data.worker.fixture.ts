/// <reference lib="webworker" />
// A decoder that never yields, used only to verify main-thread cancellation.
self.onmessage = () => { for (;;) { /* intentional CPU stall */ } };
