import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KernelMonitor, type KernelQueueView } from "./KernelMonitor";

const emptyQueue: KernelQueueView = { active: null, pending: [], paused: false };

function render(
  state: "disconnected" | "idle" | "busy",
  restartDisabled = false,
  queue = emptyQueue,
) {
  return renderToStaticMarkup(
    <KernelMonitor
      state={state}
      notebookName="analysis.ipynb"
      environmentName="/workspace/.venv"
      queue={queue}
      restartDisabled={restartDisabled}
      onSample={async () => null}
      onInterrupt={async () => undefined}
      onRestart={async () => undefined}
      onRevealExecution={() => undefined}
      onCancelQueuedFrom={() => undefined}
      onClearPending={() => undefined}
      onResumeQueue={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe("KernelMonitor", () => {
  it("offers an explicit start action for a disconnected notebook", () => {
    const markup = render("disconnected");

    expect(markup).toContain("Active kernel");
    expect(markup).toContain("analysis.ipynb");
    expect(markup).toContain(">Start</button>");
    expect(markup).not.toContain("Interrupt");
  });

  it("offers interrupt and restart while busy", () => {
    const markup = render("busy");

    expect(markup).toContain("Interrupt");
    expect(markup).toContain(">Restart</button>");
    expect(markup).not.toMatch(/disabled=""[^>]*>.*Restart<\/button>/);
  });

  it("shows active and paused pending executions with suffix cancellation", () => {
    const markup = render("idle", false, {
      active: { cellId: "a", label: "Cell 2", position: 0 },
      pending: [{ cellId: "b", label: "Cell 3", position: 1 }],
      paused: true,
    });

    expect(markup).toContain("Execution queue");
    expect(markup).toContain("Cell 2");
    expect(markup).toContain("Q1");
    expect(markup).toContain("Cancel Cell 3 and all later queued runs");
    expect(markup).toContain("Resume");
    expect(markup).toContain("Clear pending");
  });
});
