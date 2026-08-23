import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KernelMonitor } from "./KernelMonitor";

function render(state: "disconnected" | "idle" | "busy", restartDisabled = false) {
  return renderToStaticMarkup(
    <KernelMonitor
      state={state}
      notebookName="analysis.ipynb"
      environmentName="/workspace/.venv"
      restartDisabled={restartDisabled}
      onSample={async () => null}
      onInterrupt={async () => undefined}
      onRestart={async () => undefined}
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

  it("offers interrupt while busy and prevents restart", () => {
    const markup = render("busy");

    expect(markup).toContain("Interrupt");
    expect(markup).toMatch(/disabled=""[^>]*>.*Restart<\/button>/);
  });
});
