// Optional Pi Chat / AI Decision connector. Owned by Pi AI Operator.
// The bridge only fail-optional-imports this file and passes operatorPolicy.

const BASE_URL = String(process.env.PI_OPERATOR_URL || "http://127.0.0.1:8790").replace(/\/$/, "");
const TOKEN = String(process.env.PI_OPERATOR_TOKEN || "").trim();

async function request(path, options = {}) {
  if (!TOKEN) throw new Error("Pi AI Operator service token is not configured.");
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || body?.message || `Pi AI Operator returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

const client = {
  createSession: (body) => request("/v1/sessions", { method: "POST", body: JSON.stringify(body) }),
  action: (id, body) => request(`/v1/sessions/${encodeURIComponent(id)}/actions`, { method: "POST", body: JSON.stringify(body) }),
  stop: (id, reason) => request(`/v1/sessions/${encodeURIComponent(id)}/stop`, { method: "POST", body: JSON.stringify({ reason }) }),
};

function normalizeMachines(operatorPolicy) {
  if (!operatorPolicy?.enabled) return [];
  return (operatorPolicy.machines || []).map((machine) => ({
    agentId: machine.agent_id,
    hostname: machine.hostname || machine.device_facts?.hostname || machine.agent_id,
  })).filter((machine) => machine.agentId);
}

/** Injected into Pi Chat + AI Decision system prompts when Operator tools are available. */
export function operatorPromptSection(operatorPolicy) {
  const machines = normalizeMachines(operatorPolicy);
  if (!machines.length || !TOKEN) return "";
  const list = machines.map((machine) => machine.hostname).join(", ");
  const single = machines.length === 1 ? machines[0].hostname : null;
  return (
    `\n\nDESKTOP OPERATOR — control the real screen/mouse/keyboard on: ${list}\n` +
    (single ? `Machine argument may be "${single}" or "desktop".\n` : `Always pass the exact workstation hostname.\n`) +
    `PRIMARY desktop path = Tactical RMM Take Control (MeshCentral KVM) — same stack as the Take Control button.\n` +
    `Tools:\n` +
    `- operator_desktop_observe — Mesh desktop screenshot; returns screenDigest, width, height, captureId, transport=mesh-takecontrol\n` +
    `- operator_desktop_click — click at x,y from that screenshot (pass the same screenDigest)\n` +
    `- operator_desktop_type — type non-secret text at the current focus\n` +
    `- operator_desktop_key — press Enter/Tab/Esc/arrows/Space\n` +
    `- operator_stop — end the session\n` +
    `Only allowlisted Operator workstations. Browser tools (operator_navigate/login/...) remain for Edge web portals.\n` +
    `Workflow: desktop_observe → decide coordinates → desktop_click/type with that screenDigest → observe again.\n` +
    `HARD LIMITS: no Windows lock-screen/UAC unlock automation; no passwords via desktop_type (use operator_login for web passwords); no delete shortcuts; no admin Save/Apply portal mutations.\n` +
    `Independent of device Write mode.\n`
  );
}

function observation(result, hostname) {
  return JSON.stringify({
    machine: hostname,
    mode: result.mode || "browser",
    page: result.page,
    screenDigest: result.screenDigest,
    snapshotId: result.snapshotId,
    width: result.width,
    height: result.height,
    locked: result.locked,
    secureDesktop: result.secureDesktop,
    foregroundProcess: result.foregroundProcess,
    foregroundTitle: result.foregroundTitle,
    accessibility: result.accessibility,
    captureId: result.captureId,
    captureExpiresAt: result.captureExpiresAt,
  }, null, 2);
}

export function buildOperatorTools({
  Type,
  defineTool,
  text,
  operatorPolicy,
  operatorActor = "pi-chat",
  surface = "pi-chat",
}) {
  const machines = normalizeMachines(operatorPolicy);
  if (!machines.length || !TOKEN) return [];

  const sessions = new Map();
  const byName = new Map();
  for (const machine of machines) {
    byName.set(String(machine.agentId).toLowerCase(), machine);
    byName.set(String(machine.hostname).toLowerCase(), machine);
  }
  const hostList = machines.map((machine) => machine.hostname).join(", ");
  const machineDescription =
    machines.length === 1
      ? `Operator workstation hostname. Only one is allowed: ${hostList}. You may also pass "desktop".`
      : `Operator workstation hostname. One of: ${hostList}`;

  function resolveMachine(raw) {
    const key = String(raw || "").trim().toLowerCase();
    if ((!key || key === "desktop" || key === "operator" || key === "default") && machines.length === 1) {
      return machines[0];
    }
    const machine = byName.get(key);
    if (!machine) throw new Error(`Operator machine must be one of: ${hostList}`);
    return machine;
  }

  async function ensureSession(machine) {
    const existing = sessions.get(machine.agentId);
    if (existing) return existing;
    const output = await client.createSession({
      workstationId: machine.agentId,
      actor: operatorActor || surface,
      capabilities: ["observe", "navigate", "input_nonsecret", "secret_inject", "raw_input"],
      ttlSeconds: 900,
    });
    const sessionId = output.session.id;
    sessions.set(machine.agentId, sessionId);
    return sessionId;
  }

  function fields(kind) {
    return {
      machine: Type.Optional(Type.String({ description: machineDescription })),
      url: Type.String({ description: "Exact current URL from the latest Operator observation" }),
      screenDigest: Type.String({ description: "Exact screenDigest from the latest Operator observation" }),
      targetLabel: Type.String({ description: "Visible label, aria-label, placeholder, name, or link/button text" }),
      targetRole: Type.Optional(Type.String({ description: "Expected role: button, link, textbox, combobox, ..." })),
      automationId: Type.Optional(Type.String({ description: "Exact id, name, or data-testid when known" })),
      ...(kind === "browser_fill" ? { text: Type.String({ description: "Non-secret text only — never passwords/codes/tokens" }) } : {}),
      ...(kind === "browser_press" ? { key: Type.String({ description: "Non-destructive key such as Enter or ArrowDown (no Delete/Ctrl combos)" }) } : {}),
    };
  }

  const start = defineTool({
    name: "operator_start",
    label: "Start desktop Operator",
    description:
      "Start an Operator session on the workstation. Optional — desktop_observe/click auto-start. Use for full-screen desktop control and/or browser tools.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        if (sessions.has(machine.agentId)) {
          return text(`Operator session already active on ${machine.hostname}.`);
        }
        await ensureSession(machine);
        return text(
          `Operator session started on ${machine.hostname}. ` +
            `For the real desktop: operator_desktop_observe, then operator_desktop_click/type. ` +
            `Browser tools remain available. Do not unlock Windows login/UAC. Passwords only via operator_login.`,
        );
      } catch (error) {
        return text(`operator_start failed: ${error.message || error}`);
      }
    },
  });

  const desktopObserve = defineTool({
    name: "operator_desktop_observe",
    label: "Observe full desktop screen",
    description:
      "Screenshot the live Windows desktop via Tactical RMM Take Control (MeshCentral KVM). Returns screenDigest, width/height, captureId, transport=mesh-takecontrol. Call this before clicking/typing on the desktop.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = await ensureSession(machine);
        const output = await client.action(sessionId, {
          kind: "desktop_observe",
          workstationId: machine.agentId,
          purpose: "Capture live desktop screen for control",
        });
        return text(observation(output.result, machine.hostname));
      } catch (error) {
        return text(`operator_desktop_observe failed: ${error.message || error}`);
      }
    },
  });

  const desktopClick = defineTool({
    name: "operator_desktop_click",
    label: "Click on desktop screen",
    description:
      "Left-click (or right-click) at pixel coordinates on the live desktop. Requires screenDigest from the latest operator_desktop_observe. Coordinates are from that screenshot (0,0 top-left).",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
      x: Type.Number({ description: "X pixel from left" }),
      y: Type.Number({ description: "Y pixel from top" }),
      screenDigest: Type.String({ description: "Exact screenDigest from latest desktop observe" }),
      button: Type.Optional(Type.String({ description: "left (default) or right" })),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = await ensureSession(machine);
        const button = String(params.button || "left").toLowerCase();
        const output = await client.action(sessionId, {
          kind: "raw_mouse",
          workstationId: machine.agentId,
          purpose: `Desktop ${button} click at ${params.x},${params.y}`,
          command: button === "right" ? "right_click" : "click",
          x: params.x,
          y: params.y,
          screenDigest: params.screenDigest,
          target: { x: params.x, y: params.y, label: `desktop:${params.x},${params.y}` },
        });
        return text(observation(output.result, machine.hostname));
      } catch (error) {
        return text(`operator_desktop_click failed: ${error.message || error}`);
      }
    },
  });

  const desktopType = defineTool({
    name: "operator_desktop_type",
    label: "Type on desktop keyboard",
    description:
      "Type non-secret text into the currently focused desktop window. Requires screenDigest from latest desktop observe. Never type passwords here.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
      text: Type.String({ description: "Non-secret text to type" }),
      screenDigest: Type.String({ description: "Exact screenDigest from latest desktop observe" }),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = await ensureSession(machine);
        const output = await client.action(sessionId, {
          kind: "raw_keyboard",
          workstationId: machine.agentId,
          purpose: "Desktop keyboard type",
          command: "type",
          text: params.text,
          screenDigest: params.screenDigest,
          target: { label: "desktop-focus" },
        });
        return text(observation(output.result, machine.hostname));
      } catch (error) {
        return text(`operator_desktop_type failed: ${error.message || error}`);
      }
    },
  });

  const desktopKey = defineTool({
    name: "operator_desktop_key",
    label: "Press desktop key",
    description: "Press Enter, Tab, Escape, arrows, Home, End, or Space on the desktop. Requires screenDigest from latest desktop observe.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
      key: Type.String({ description: "Enter|Tab|Escape|Left|Up|Right|Down|Home|End|Space" }),
      screenDigest: Type.String({ description: "Exact screenDigest from latest desktop observe" }),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = await ensureSession(machine);
        const output = await client.action(sessionId, {
          kind: "raw_keyboard",
          workstationId: machine.agentId,
          purpose: `Desktop key ${params.key}`,
          command: "press",
          key: params.key,
          screenDigest: params.screenDigest,
          target: { label: "desktop-focus" },
        });
        return text(observation(output.result, machine.hostname));
      } catch (error) {
        return text(`operator_desktop_key failed: ${error.message || error}`);
      }
    },
  });

  const navigate = defineTool({
    name: "operator_navigate",
    label: "Open page on desktop browser",
    description:
      "Open an HTTPS URL in the dedicated Operator Edge browser on the admin workstation and return page state (title, url, accessibility labels, screenDigest). Auto-starts the session. Use this when the tech asks to open/visit a website on the desktop Operator machine.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
      url: Type.String({ description: "HTTPS URL to open" }),
      purpose: Type.Optional(Type.String({ description: "Why you are opening this page" })),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = await ensureSession(machine);
        const output = await client.action(sessionId, {
          kind: "navigate",
          workstationId: machine.agentId,
          purpose: params.purpose || "Open page requested by technician",
          url: params.url,
        });
        return text(observation(output.result, machine.hostname));
      } catch (error) {
        return text(`operator_navigate failed: ${error.message || error}`);
      }
    },
  });

  const observe = defineTool({
    name: "operator_observe",
    label: "Observe desktop browser",
    description:
      "Capture the current Operator Edge page without navigating. Returns fresh url, screenDigest, and accessibility labels. Auto-starts if needed. Call this before click/fill if the last observation may be stale.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = await ensureSession(machine);
        const output = await client.action(sessionId, {
          kind: "observe",
          workstationId: machine.agentId,
          purpose: "Observe current browser state",
        });
        return text(observation(output.result, machine.hostname));
      } catch (error) {
        return text(`operator_observe failed: ${error.message || error}`);
      }
    },
  });

  function inputTool(name, label, kind, description) {
    return defineTool({
      name,
      label,
      description,
      parameters: Type.Object(fields(kind)),
      execute: async (_id, params) => {
        try {
          const machine = resolveMachine(params.machine);
          const sessionId = await ensureSession(machine);
          const output = await client.action(sessionId, {
            kind,
            workstationId: machine.agentId,
            purpose: `${label}: ${params.targetLabel}`,
            url: params.url,
            screenDigest: params.screenDigest,
            target: {
              label: params.targetLabel,
              role: params.targetRole || "",
              automationId: params.automationId || "",
            },
            ...(params.text !== undefined ? { text: params.text } : {}),
            ...(params.key ? { key: params.key } : {}),
          });
          return text(observation(output.result, machine.hostname));
        } catch (error) {
          return text(`${name} failed: ${error.message || error}`);
        }
      },
    });
  }

  const login = defineTool({
    name: "operator_login",
    label: "Sign in on desktop browser",
    description:
      "Sign into a web login page on the Operator workstation using brokered credentials. " +
      "secretRef 'device-memory' reads username/password from that workstation's Device Memory (ai notes). " +
      "Never pass password values. Never echo credentials. Opens the URL if provided, injects username/password, " +
      "and clicks Next/Sign in when present. MFA is not completed automatically.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
      url: Type.Optional(Type.String({
        description: "HTTPS login URL (e.g. https://login.microsoftonline.com or https://admin.microsoft.com)",
      })),
      secretRef: Type.Optional(Type.String({
        description: "Opaque secret reference. Default: device-memory",
      })),
      clickAfter: Type.Optional(Type.Boolean({
        description: "Click Next/Sign in after filling (default true)",
      })),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = await ensureSession(machine);
        const secretRef = String(params.secretRef || "device-memory").trim() || "device-memory";
        const clickAfter = params.clickAfter !== false;
        let pageUrl = params.url || "";
        if (pageUrl) {
          await client.action(sessionId, {
            kind: "navigate",
            workstationId: machine.agentId,
            purpose: "Open login page for brokered sign-in",
            url: pageUrl,
          });
        }
        const observed = await client.action(sessionId, {
          kind: "observe",
          workstationId: machine.agentId,
          purpose: "Capture login page before secret injection",
        });
        pageUrl = observed.result?.page?.url || pageUrl;
        const injected = await client.action(sessionId, {
          kind: "secret_inject",
          workstationId: machine.agentId,
          purpose: "Brokered credential injection for technician-requested sign-in",
          url: pageUrl,
          screenDigest: observed.result?.screenDigest,
          secretRef,
          clickAfter,
        });
        const result = injected.result || {};
        return text(JSON.stringify({
          machine: machine.hostname,
          ok: true,
          secretRef,
          page: result.page,
          screenDigest: result.screenDigest,
          inject: result.secretInject || result.inject || { usernameFilled: true, passwordFilled: true },
          accessibility: result.accessibility,
          note: "Credentials were injected by the broker and are not shown here. If MFA is required, ask the technician.",
        }, null, 2));
      } catch (error) {
        return text(`operator_login failed: ${error.message || error}`);
      }
    },
  });

  const stop = defineTool({
    name: "operator_stop",
    label: "Stop desktop Operator",
    description: "Stop the Operator Edge session and close the dedicated browser on the workstation. Call when finished.",
    parameters: Type.Object({
      machine: Type.Optional(Type.String({ description: machineDescription })),
    }),
    execute: async (_id, params) => {
      try {
        const machine = resolveMachine(params.machine);
        const sessionId = sessions.get(machine.agentId);
        if (!sessionId) return text(`No active Operator session on ${machine.hostname}.`);
        await client.stop(sessionId, `Stopped from ${surface}`);
        sessions.delete(machine.agentId);
        return text(`Operator session stopped on ${machine.hostname}.`);
      } catch (error) {
        return text(`operator_stop failed: ${error.message || error}`);
      }
    },
  });

  return [
    start,
    desktopObserve,
    desktopClick,
    desktopType,
    desktopKey,
    navigate,
    observe,
    login,
    inputTool(
      "operator_click",
      "Click browser element",
      "browser_click",
      "Click a button/link/control on the Operator browser by visible label. Requires exact url + screenDigest from the latest observation. Destructive labels (delete/remove/...) are denied.",
    ),
    inputTool(
      "operator_fill",
      "Fill browser field",
      "browser_fill",
      "Type non-secret text into a field on the Operator browser. Requires exact url + screenDigest + targetLabel. Password/code/token fields are denied. Do not use this to submit/save admin changes.",
    ),
    inputTool(
      "operator_press",
      "Press key in browser",
      "browser_press",
      "Press a simple key (Enter, ArrowDown, Tab, ...) focused on a labeled control. Requires url + screenDigest + targetLabel. Delete/Backspace and Ctrl/Alt/Shift shortcuts are blocked. Enter inside a form is blocked to prevent accidental submit.",
    ),
    stop,
  ];
}
