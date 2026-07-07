"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // plugins/anoclaw-workflow/frontend/src/WorkflowNodeTypes.ts
  var NODE_DEFS = {
    agent_task: {
      label: "Agent Task",
      color: "#57c1ff",
      group: "AI Orchestration",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/></svg>`,
      defaultTitle: "Agent Task",
      inputLabels: ["Trigger"],
      outputLabels: ["Done"],
      params: [
        { label: "Task Description", type: "textarea", key: "prompt", placeholder: "Describe the task... Use {{variables}} for dynamic values" },
        { label: "Assign Agent", type: "select", key: "agentId", options: [{ value: "", label: "Auto Assign" }, { value: "mainagent", label: "Main Agent" }, { value: "manager", label: "Manager" }, { value: "member", label: "Member" }] }
      ]
    },
    loop: {
      label: "Loop",
      color: "#3b82f6",
      group: "Flow Control",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>`,
      defaultTitle: "Loop",
      inputLabels: ["Trigger"],
      outputLabels: ["Done"],
      params: [{ label: "Max Iterations", type: "number", key: "maxIterations", placeholder: "0 = infinite" }]
    },
    end: {
      label: "End",
      color: "#10b981",
      group: "Flow Control",
      inputs: 1,
      outputs: 0,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>`,
      defaultTitle: "End",
      inputLabels: ["Output"],
      outputLabels: [],
      params: []
    },
    wait: {
      label: "Wait",
      color: "#94a3b8",
      group: "Flow Control",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
      defaultTitle: "Wait",
      inputLabels: ["Trigger"],
      outputLabels: ["Done"],
      params: [{ label: "Seconds", type: "number", key: "seconds", placeholder: "5" }]
    },
    http_request: {
      label: "HTTP Request",
      color: "#f59e0b",
      group: "Integrations",
      inputs: 1,
      outputs: 2,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
      defaultTitle: "HTTP Request",
      inputLabels: ["Trigger"],
      outputLabels: ["Success", "Error"],
      params: [
        { label: "Method", type: "select", key: "method", options: [{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }, { value: "PUT", label: "PUT" }, { value: "DELETE", label: "DELETE" }, { value: "PATCH", label: "PATCH" }] },
        { label: "URL", type: "text", key: "url", placeholder: "https://api.example.com/endpoint" },
        { label: "Headers (JSON)", type: "textarea", key: "headers", placeholder: '{"Content-Type": "application/json"}' },
        { label: "Body (JSON)", type: "textarea", key: "body", placeholder: '{"key": "value"}' }
      ]
    },
    code_transform: {
      label: "Code Transform",
      color: "#06b6d4",
      group: "Transforms",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
      defaultTitle: "Code Transform",
      inputLabels: ["Input"],
      outputLabels: ["Output"],
      params: [
        { label: "JavaScript Code", type: "textarea", key: "code", placeholder: "// input variable holds the input value\nreturn input;" },
        { label: "Output Variable", type: "text", key: "outputVar", placeholder: "result" }
      ]
    },
    condition: {
      label: "Condition",
      color: "#ffc533",
      group: "Flow Control",
      inputs: 1,
      outputs: 2,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`,
      defaultTitle: "Condition",
      inputLabels: ["Input"],
      outputLabels: ["True", "False"],
      params: [
        { label: "Expression", type: "text", key: "expression", placeholder: '{{result}} === "success"' }
      ]
    },
    set_variable: {
      label: "Set Variable",
      color: "#57c1ff",
      group: "Variables",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
      defaultTitle: "Set Variable",
      inputLabels: ["Trigger"],
      outputLabels: ["Done"],
      params: [
        { label: "Variable Name", type: "text", key: "varName", placeholder: "myVariable" },
        { label: "Value (supports {{expressions}})", type: "text", key: "varValue", placeholder: "{{previousNode.result}}" }
      ]
    },
    delay: {
      label: "Delay",
      color: "#64748b",
      group: "Flow Control",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 8 14"/></svg>`,
      defaultTitle: "Delay",
      inputLabels: ["Trigger"],
      outputLabels: ["Done"],
      params: [
        { label: "Duration (ms)", type: "number", key: "durationMs", placeholder: "1000" }
      ]
    },
    webhook: {
      label: "Webhook",
      color: "#22c55e",
      group: "Integrations",
      inputs: 0,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
      defaultTitle: "Webhook",
      inputLabels: [],
      outputLabels: ["Received"],
      params: [
        { label: "Path", type: "text", key: "path", placeholder: "/my-webhook" },
        { label: "Method", type: "select", key: "method", options: [{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }, { value: "PUT", label: "PUT" }] }
      ]
    },
    database_query: {
      label: "Database Query",
      color: "#57c1ff",
      group: "Data",
      inputs: 1,
      outputs: 2,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
      defaultTitle: "Database Query",
      inputLabels: ["Trigger"],
      outputLabels: ["Results", "Error"],
      params: [
        { label: "Connection", type: "select", key: "connection", options: [{ value: "postgres", label: "PostgreSQL" }, { value: "mysql", label: "MySQL" }, { value: "mongo", label: "MongoDB" }, { value: "sqlite", label: "SQLite" }] },
        { label: "Query", type: "textarea", key: "query", placeholder: "SELECT * FROM users WHERE active = true" },
        { label: "Output Variable", type: "text", key: "outputVar", placeholder: "queryResult" }
      ]
    },
    file_read: {
      label: "File Read/Write",
      color: "#fb923c",
      group: "Data",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
      defaultTitle: "File Read/Write",
      inputLabels: ["Trigger"],
      outputLabels: ["Done"],
      params: [
        { label: "Operation", type: "select", key: "operation", options: [{ value: "read", label: "Read File" }, { value: "write", label: "Write File" }, { value: "append", label: "Append to File" }, { value: "exists", label: "Check Exists" }] },
        { label: "File Path", type: "text", key: "filePath", placeholder: "/path/to/file.txt" },
        { label: "Content (for write/append)", type: "textarea", key: "content", placeholder: "{{variable}} or raw content" },
        { label: "Output Variable", type: "text", key: "outputVar", placeholder: "fileContent" }
      ]
    },
    sub_workflow: {
      label: "Sub-Workflow",
      color: "#14b8a6",
      group: "Orchestration",
      inputs: 1,
      outputs: 1,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M6 8h4"/><path d="M6 11h8"/></svg>`,
      defaultTitle: "Sub-Workflow",
      inputLabels: ["Trigger"],
      outputLabels: ["Done"],
      params: [
        { label: "Workflow ID", type: "text", key: "targetWorkflowId", placeholder: "wf_xxxxx" },
        { label: "Pass Variables", type: "textarea", key: "passVars", placeholder: "key1,key2 (comma-separated variable names to pass)" },
        { label: "Output Variable", type: "text", key: "outputVar", placeholder: "subResult" }
      ]
    },
    approval: {
      label: "Approval",
      color: "#f43f5e",
      group: "Human-in-the-Loop",
      inputs: 1,
      outputs: 2,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>`,
      defaultTitle: "Approval",
      inputLabels: ["Trigger"],
      outputLabels: ["Approved", "Rejected"],
      params: [
        { label: "Prompt", type: "textarea", key: "prompt", placeholder: "Please approve this action..." },
        { label: "Timeout (seconds)", type: "number", key: "timeout", placeholder: "300" }
      ]
    }
  };
  var PALETTE_GROUPS = [
    { label: "AI Orchestration", types: ["agent_task"] },
    { label: "Flow Control", types: ["loop", "end", "wait", "condition", "delay"] },
    { label: "Data", types: ["database_query", "file_read"] },
    { label: "Integrations", types: ["http_request", "webhook"] },
    { label: "Transforms", types: ["code_transform"] },
    { label: "Variables", types: ["set_variable"] },
    { label: "Orchestration", types: ["sub_workflow"] },
    { label: "Human-in-the-Loop", types: ["approval"] }
  ];
  var STORAGE_KEY = "anoclaw-workflow-v2";
  var MIN_ZOOM = 0.5;
  var MAX_ZOOM = 2;
  var GRID_SIZE = 20;
  var _nodeIdSeq = 0;
  var _connIdSeq = 0;
  var _groupIdSeq = 0;
  var _wfIdSeq = 0;
  function nextNodeId() {
    _nodeIdSeq++;
    return "n" + _nodeIdSeq;
  }
  function nextConnId() {
    _connIdSeq++;
    return "c" + _connIdSeq;
  }
  function nextGroupId() {
    _groupIdSeq++;
    return "g" + _groupIdSeq;
  }
  function resetIdSeqs(nodes, conns, groups, wfs) {
    _nodeIdSeq = 0;
    _connIdSeq = 0;
    _groupIdSeq = 0;
    _wfIdSeq = 0;
    for (const n of nodes) {
      const m = n.id.match(/^n(\d+)$/);
      if (m) _nodeIdSeq = Math.max(_nodeIdSeq, parseInt(m[1], 10));
    }
    for (const c of conns) {
      const m = c.id.match(/^c(\d+)$/);
      if (m) _connIdSeq = Math.max(_connIdSeq, parseInt(m[1], 10));
    }
    for (const g of groups) {
      const m = g.id.match(/^g(\d+)$/);
      if (m) _groupIdSeq = Math.max(_groupIdSeq, parseInt(m[1], 10));
    }
    for (const w of wfs) {
      const m = w.id.match(/^wf(\d+)$/);
      if (m) _wfIdSeq = Math.max(_wfIdSeq, parseInt(m[1], 10));
    }
  }

  // plugins/anoclaw-workflow/frontend/src/WorkflowRendering.ts
  function escapeHtml(s) {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }
  var STATUS_COLORS = {
    idle: "rgba(255,255,255,0.08)",
    queued: "#6a6b6c",
    running: "#ffc533",
    success: "#59d499",
    error: "#ff6161"
  };
  var STATUS_BORDERS = {
    running: "rgba(255,197,51,0.55)",
    success: "rgba(89,212,153,0.45)",
    error: "rgba(255,97,97,0.45)"
  };
  function renderNode(node, isSelected, callbacks, selectedNodeIds) {
    const def = NODE_DEFS[node.type];
    const el = document.createElement("div");
    el.className = "workflow-node" + (isSelected ? " workflow-node-selected" : "");
    el.style.left = node.x + "px";
    el.style.top = node.y + "px";
    el.setAttribute("data-node-id", node.id);
    const headerColor = def?.color || "#57c1ff";
    const typeLabel = def?.label || node.type;
    const iconSvg = def?.icon || "";
    const statusColor = STATUS_COLORS[node.status] || STATUS_COLORS.idle;
    const statusBorder = STATUS_BORDERS[node.status] || "";
    const isRunning = node.status === "running";
    if (selectedNodeIds?.has(node.id)) {
      el.classList.add("workflow-node-multi-selected");
    }
    el.innerHTML = `
    <div class="workflow-node-header" style="--workflow-type-color:${headerColor};" data-drag-handle>
      <span class="workflow-node-status-dot" style="background:${statusColor};${isRunning ? "animation:nodeStatusPulse 1s ease-in-out infinite;" : ""}"></span>
      <span class="workflow-node-type-icon">${iconSvg}</span>
      <span class="workflow-node-type-label">${typeLabel}</span>
      <span class="workflow-node-title">${escapeHtml(node.title)}</span>
      <button class="workflow-node-delete" data-delete-btn>&times;</button>
    </div>
    <div class="workflow-node-body" data-node-body>
      ${(def?.params || []).map((p) => `
        <div class="workflow-node-param">
          <label class="workflow-node-param-label">${p.label}</label>
          ${renderParamInput(p.type, p.key, p.placeholder || "", node.data?.[p.key] || node.params?.[p.key] || "", p.options)}
        </div>`).join("")}
    </div>
    <div class="workflow-node-footer">
      <div class="workflow-ports-group ports-in-group">
        ${(node.inputLabels || []).map((label, i) => `
          <div class="workflow-port-wrapper">
            <div class="workflow-port" data-port="in" data-port-index="${i}" title="${escapeHtml(label)}"></div>
            <span class="workflow-port-label">${escapeHtml(label)}</span>
          </div>`).join("")}
      </div>
      <div class="workflow-ports-group ports-out-group">
        ${(node.outputLabels || []).map((label, i) => `
          <div class="workflow-port-wrapper">
            <span class="workflow-port-label">${escapeHtml(label)}</span>
            <div class="workflow-port" data-port="out" data-port-index="${i}" title="${escapeHtml(label)}"></div>
          </div>`).join("")}
      </div>
    </div>`;
    if (statusBorder && !isSelected) {
      el.style.borderColor = statusBorder;
    }
    const header = el.querySelector("[data-drag-handle]");
    header?.addEventListener("mousedown", (e) => {
      if (e.target.closest(".workflow-node-delete") || e.target.closest("textarea") || e.target.closest("select") || e.target.closest("input")) return;
      e.stopPropagation();
      callbacks.onMoveStart(e);
    });
    el.querySelector("[data-delete-btn]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      callbacks.onDelete();
    });
    el.querySelectorAll(".workflow-node-textarea, .workflow-node-select, .workflow-node-input").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.getAttribute("data-param-key");
        callbacks.onParamChange(key, input.value);
      });
    });
    el.querySelectorAll("[data-port]").forEach((port) => {
      port.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        const isOutput = port.getAttribute("data-port") === "out";
        const portIndex = parseInt(port.getAttribute("data-port-index") || "0");
        callbacks.onPortMouseDown(portIndex, isOutput, e);
      });
    });
    return el;
  }
  function renderParamInput(type, key, placeholder, value, options) {
    const v = escapeHtml(value || "");
    const ph = escapeHtml(placeholder);
    if (type === "textarea") {
      return `<textarea class="workflow-node-textarea" data-param-key="${key}" placeholder="${ph}" rows="3">${v}</textarea>`;
    }
    if (type === "select" && options) {
      return `<select class="workflow-node-select" data-param-key="${key}">${options.map((o) => `<option value="${o.value}"${o.value === value ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>`;
    }
    return `<input class="workflow-node-input" type="${type === "number" ? "number" : "text"}" data-param-key="${key}" placeholder="${ph}" value="${v}">`;
  }
  function renderConnections(svg, connections, nodes, selectedId, onSelect, executionState, nodesLayer, zoom) {
    svg.innerHTML = "";
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
    <linearGradient id="flow-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffc533" stop-opacity="0"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#ffc533" stop-opacity="0"/>
    </linearGradient>
  `;
    svg.appendChild(defs);
    const activeConnKeys = /* @__PURE__ */ new Set();
    if (executionState?.status === "running" && executionState?.currentNodeId) {
      for (const conn of connections) {
        if (conn.fromNodeId === executionState.currentNodeId || conn.toNodeId === executionState.currentNodeId) {
          activeConnKeys.add(`${conn.fromNodeId}->${conn.toNodeId}`);
        }
      }
    }
    for (const conn of connections) {
      const fromNode = nodes.find((n) => n.id === conn.fromNodeId);
      const toNode = nodes.find((n) => n.id === conn.toNodeId);
      if (!fromNode || !toNode) continue;
      const fromPort = getPortPosition(fromNode, conn.fromPortIndex, false, nodesLayer, zoom);
      const toPort = getPortPosition(toNode, conn.toPortIndex, true, nodesLayer, zoom);
      if (!fromPort || !toPort) continue;
      const isSelected = conn.id === selectedId;
      const connKey = `${conn.fromNodeId}->${conn.toNodeId}`;
      const isActive = activeConnKeys.has(connKey);
      const d = bezierPath(fromPort.x, fromPort.y, toPort.x, toPort.y);
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "workflow-conn-hitarea");
      hit.addEventListener("click", () => onSelect(conn.id));
      svg.appendChild(hit);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "workflow-conn-path" + (isSelected ? " workflow-conn-selected" : "") + (isActive ? " workflow-conn-active" : ""));
      path.addEventListener("click", () => onSelect(conn.id));
      svg.appendChild(path);
      if (isActive) {
        const flowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        flowPath.setAttribute("d", d);
        flowPath.setAttribute("class", "workflow-conn-flow");
        flowPath.setAttribute("stroke", "url(#flow-gradient)");
        flowPath.setAttribute("fill", "none");
        flowPath.setAttribute("stroke-width", "3");
        svg.appendChild(flowPath);
      }
    }
  }
  function updateConnectionPaths(svg, connections, nodes, nodesLayer, zoom) {
    const hitAreas = svg.querySelectorAll(".workflow-conn-hitarea");
    const paths = svg.querySelectorAll(".workflow-conn-path");
    let i = 0;
    for (const conn of connections) {
      const fromNode = nodes.find((n) => n.id === conn.fromNodeId);
      const toNode = nodes.find((n) => n.id === conn.toNodeId);
      if (!fromNode || !toNode) continue;
      const fromPort = getPortPosition(fromNode, conn.fromPortIndex, false, nodesLayer, zoom);
      const toPort = getPortPosition(toNode, conn.toPortIndex, true, nodesLayer, zoom);
      if (!fromPort || !toPort) continue;
      const d = bezierPath(fromPort.x, fromPort.y, toPort.x, toPort.y);
      if (hitAreas[i]) hitAreas[i].setAttribute("d", d);
      if (paths[i]) paths[i].setAttribute("d", d);
      i++;
    }
  }
  function getPortPosition(node, portIndex, isInput, nodesLayer, zoom) {
    if (nodesLayer && zoom !== void 0) {
      const nodeEl = nodesLayer.querySelector(`[data-node-id="${node.id}"]`);
      if (nodeEl) {
        const portEl = nodeEl.querySelector(`[data-port="${isInput ? "in" : "out"}"][data-port-index="${portIndex}"]`);
        if (portEl) {
          const nodeRect = nodeEl.getBoundingClientRect();
          const portRect = portEl.getBoundingClientRect();
          const localX = isInput ? (portRect.left - nodeRect.left) / zoom : (portRect.right - nodeRect.left) / zoom;
          const localY = (portRect.top + portRect.height / 2 - nodeRect.top) / zoom;
          return { x: node.x + localX, y: node.y + localY };
        }
      }
    }
    const nodeW = 200;
    const headerH = 36;
    const bodyH = (NODE_DEFS[node.type]?.params.length || 0) * 60 + 20;
    const footerH = 28;
    const totalH = headerH + bodyH + footerH;
    const portSpacing = 20;
    const portH = headerH + bodyH + 6 + portIndex * portSpacing;
    return {
      x: node.x + (isInput ? 0 : nodeW),
      y: node.y + Math.min(portH, totalH - 12)
    };
  }
  function bezierPath(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1) * 0.5;
    const cx1 = x1 + dx;
    const cx2 = x2 - dx;
    return `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
  }
  function renderMinimap(canvas, nodes, conns, viewportW, viewportH, offsetX, offsetY, zoom, groups, onClick) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const style2 = getComputedStyle(document.documentElement);
    const cssVar = (name, fallback) => style2.getPropertyValue(name)?.trim() || fallback;
    const bgColor = cssVar("--color-bg", "#07080a");
    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, w, h);
    let minX = 0, minY = 0, maxX = 2e3, maxY = 1500;
    if (nodes.length > 0) {
      minX = Math.min(...nodes.map((n) => n.x));
      minY = Math.min(...nodes.map((n) => n.y));
      maxX = Math.max(...nodes.map((n) => n.x + 200));
      maxY = Math.max(...nodes.map((n) => n.y + 120));
    }
    const bw = maxX - minX + 40, bh = maxY - minY + 40;
    const scaleX = w / bw, scaleY = h / bh;
    const scale = Math.min(scaleX, scaleY);
    if (groups && groups.length > 0) {
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      for (const g of groups) {
        const groupNodes = nodes.filter((n) => g.nodeIds.includes(n.id));
        if (groupNodes.length === 0) continue;
        const gx = Math.min(...groupNodes.map((n) => n.x));
        const gy = Math.min(...groupNodes.map((n) => n.y));
        const gw = Math.max(...groupNodes.map((n) => n.x + 200)) - gx + 20;
        const gh = Math.max(...groupNodes.map((n) => n.y + 120)) - gy + 20;
        ctx.fillRect((gx - minX + 10) * scale, (gy - minY + 10) * scale, gw * scale, gh * scale);
      }
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    for (const c of conns) {
      const fn = nodes.find((n) => n.id === c.fromNodeId);
      const tn = nodes.find((n) => n.id === c.toNodeId);
      if (!fn || !tn) continue;
      ctx.beginPath();
      ctx.moveTo((fn.x - minX + 120) * scale, (fn.y - minY + 60) * scale);
      ctx.lineTo((tn.x - minX + 120) * scale, (tn.y - minY + 60) * scale);
      ctx.stroke();
    }
    for (const n of nodes) {
      const def = NODE_DEFS[n.type];
      const statusCol = n.status === "running" ? "rgba(255,197,51,0.7)" : n.status === "success" ? "rgba(89,212,153,0.7)" : n.status === "error" ? "rgba(255,97,97,0.7)" : def?.color ? def.color + "88" : "rgba(255,255,255,0.3)";
      ctx.fillStyle = statusCol;
      ctx.fillRect((n.x - minX + 20) * scale, (n.y - minY + 20) * scale, 200 * scale, 100 * scale);
    }
    const vx = (-offsetX / zoom - minX + 20) * scale;
    const vy = (-offsetY / zoom - minY + 20) * scale;
    const vw = viewportW / zoom * scale;
    const vh = viewportH / zoom * scale;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, vw, vh);
    if (onClick && !canvas.dataset.clickWired) {
      canvas.dataset.clickWired = "1";
      canvas.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        onClick(cx, cy, w, h);
      });
    }
  }

  // plugins/anoclaw-workflow/frontend/src/WorkflowCanvas.ts
  var WorkflowCanvasController = class {
    constructor(container, canvas, svgLayer, cb) {
      __publicField(this, "_container");
      __publicField(this, "_canvas");
      __publicField(this, "_svgLayer");
      __publicField(this, "_cb");
      __publicField(this, "state", { offsetX: 0, offsetY: 0, zoom: 1 });
      /** Snap-to-grid toggle */
      __publicField(this, "snapToGrid", false);
      // Drag state
      __publicField(this, "_dragging", null);
      __publicField(this, "_connectDragging", null);
      __publicField(this, "_selectedConnId", null);
      __publicField(this, "_hasMoved", false);
      // Undo/Redo history
      __publicField(this, "_undoStack", []);
      __publicField(this, "_redoStack", []);
      __publicField(this, "_maxHistorySize", 50);
      this._container = container;
      this._canvas = canvas;
      this._svgLayer = svgLayer;
      this._cb = cb;
      this._container.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const target = e.target;
        if (target.closest(".workflow-node") || target.closest(".workflow-conn-path") || target.closest(".workflow-conn-hitarea") || target.closest(".workflow-port") || target.closest(".workflow-context-menu") || target.closest(".workflow-group-container")) return;
        this._dragging = { type: "canvas" };
        this._hasMoved = false;
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!this._dragging) return;
        this._hasMoved = true;
        if (this._dragging.type === "canvas") {
          this.state.offsetX += e.movementX;
          this.state.offsetY += e.movementY;
          this._cb.onUpdateView();
        } else if (this._dragging.type === "node") {
          const dx = (e.clientX - this._dragging.startX) / this.state.zoom;
          const dy = (e.clientY - this._dragging.startY) / this.state.zoom;
          let newX = Math.round(this._dragging.nodeStartX + dx);
          let newY = Math.round(this._dragging.nodeStartY + dy);
          if (this.snapToGrid) {
            newX = Math.round(newX / GRID_SIZE) * GRID_SIZE;
            newY = Math.round(newY / GRID_SIZE) * GRID_SIZE;
          }
          const _nd = this._dragging;
          const el = this._container.querySelector(`[data-node-id="${_nd.nodeId}"]`);
          if (el) {
            el.style.left = newX + "px";
            el.style.top = newY + "px";
          }
          const node = this._cb.getNodes().find((n) => n.id === _nd.nodeId);
          if (node) {
            node.x = newX;
            node.y = newY;
          }
          updateConnectionPaths(this._svgLayer, this._cb.getConnections(), this._cb.getNodes(), this._container.querySelector("#wf-nodes-layer"), this.state.zoom);
        }
      });
      window.addEventListener("mouseup", (e) => {
        if (!this._dragging) return;
        if (this._dragging.type === "node" && this._hasMoved) {
          const _nd2 = this._dragging;
          const el = this._container.querySelector(`[data-node-id="${_nd2.nodeId}"]`);
          if (el) {
            const newX = parseInt(el.style.left) || 0;
            const newY = parseInt(el.style.top) || 0;
            this._cb.onNodeMoved(_nd2.nodeId, newX, newY);
          } else {
            const node = this._cb.getNodes().find((n) => n.id === _nd2.nodeId);
            if (node) this._cb.onNodeMoved(node.id, node.x, node.y);
          }
        }
        if (!this._hasMoved && this._dragging.type === "canvas") {
          this._cb.onNodeSelected(null);
        }
        if (this._connectDragging) {
          this._connectDragging.tempPath.remove();
          this._connectDragging = null;
        }
        this._dragging = null;
      });
      document.addEventListener("mouseleave", () => {
        if (this._dragging || this._connectDragging) {
          if (this._connectDragging) {
            this._connectDragging.tempPath.remove();
            this._connectDragging = null;
          }
          this._dragging = null;
        }
      });
      this._container.addEventListener("wheel", (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.state.zoom + delta));
        if (newZoom === this.state.zoom) return;
        const rect = this._container.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const scale = newZoom / this.state.zoom;
        this.state.offsetX = mx - (mx - this.state.offsetX) * scale;
        this.state.offsetY = my - (my - this.state.offsetY) * scale;
        this.state.zoom = newZoom;
        this._cb.onUpdateView();
      }, { passive: false });
    }
    /** Toggle snap-to-grid */
    toggleSnapToGrid() {
      this.snapToGrid = !this.snapToGrid;
      return this.snapToGrid;
    }
    // ── Undo/Redo History ──
    /** Push current state to undo stack */
    pushState(description) {
      const nodes = this._cb.getNodes();
      const connections = this._cb.getConnections();
      const snapshot = {
        nodes: JSON.parse(JSON.stringify(nodes)),
        connections: JSON.parse(JSON.stringify(connections)),
        description
      };
      this._undoStack.push(snapshot);
      if (this._undoStack.length > this._maxHistorySize) {
        this._undoStack.shift();
      }
      this._redoStack = [];
      this._cb.onStateChange?.();
    }
    /** Undo last action */
    undo() {
      if (this._undoStack.length === 0) return false;
      const snapshot = this._undoStack.pop();
      const currentNodes = this._cb.getNodes();
      const currentConns = this._cb.getConnections();
      this._redoStack.push({
        nodes: JSON.parse(JSON.stringify(currentNodes)),
        connections: JSON.parse(JSON.stringify(currentConns)),
        description: snapshot.description
      });
      this._restoreSnapshot(snapshot);
      this._cb.onStateChange?.();
      return true;
    }
    /** Redo last undone action */
    redo() {
      if (this._redoStack.length === 0) return false;
      const snapshot = this._redoStack.pop();
      const currentNodes = this._cb.getNodes();
      const currentConns = this._cb.getConnections();
      this._undoStack.push({
        nodes: JSON.parse(JSON.stringify(currentNodes)),
        connections: JSON.parse(JSON.stringify(currentConns)),
        description: snapshot.description
      });
      this._restoreSnapshot(snapshot);
      this._cb.onStateChange?.();
      return true;
    }
    /** Restore a snapshot by replacing the nodes and connections arrays */
    _restoreSnapshot(snapshot) {
      const nodes = this._cb.getNodes();
      const connections = this._cb.getConnections();
      nodes.length = 0;
      connections.length = 0;
      for (const n of snapshot.nodes) nodes.push(n);
      for (const c of snapshot.connections) connections.push(c);
    }
    /** Check if undo/redo is available */
    get canUndo() {
      return this._undoStack.length > 0;
    }
    get canRedo() {
      return this._redoStack.length > 0;
    }
    get undoDescription() {
      return this._undoStack.length > 0 ? this._undoStack[this._undoStack.length - 1].description : null;
    }
    get redoDescription() {
      return this._redoStack.length > 0 ? this._redoStack[this._redoStack.length - 1].description : null;
    }
    /** Start dragging a node */
    startNodeDrag(nodeId, x, y, e) {
      this._dragging = { type: "node", nodeId, startX: e.clientX, startY: e.clientY, nodeStartX: x, nodeStartY: y };
      this._hasMoved = false;
    }
    /** Start port connection drag */
    startPortConnect(nodeId, portIndex, isOutput, e) {
      const node = this._cb.getNodes().find((n) => n.id === nodeId);
      if (!node) return;
      const portPos = getPortPosition(node, portIndex, !isOutput, this._container.querySelector("#wf-nodes-layer"), this.state.zoom);
      if (!portPos) return;
      if (this._connectDragging) {
        this._connectDragging.tempPath.remove();
      }
      const fromNodeId = isOutput ? nodeId : "";
      const fromPortIndex = isOutput ? portIndex : -1;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "workflow-temp-path");
      const startX = portPos.x;
      const startY = portPos.y;
      path.setAttribute("d", `M ${startX} ${startY} L ${startX} ${startY}`);
      this._svgLayer.appendChild(path);
      this._connectDragging = {
        fromNodeId: isOutput ? nodeId : "",
        fromPortIndex: isOutput ? portIndex : 0,
        fromX: startX,
        fromY: startY,
        tempPath: path,
        sourceNodeId: nodeId,
        sourcePortIndex: portIndex,
        sourceIsOutput: isOutput
      };
      const onMove = (ev) => {
        if (!this._connectDragging) return;
        const rect = this._container.getBoundingClientRect();
        const mx = (ev.clientX - rect.left - this.state.offsetX) / this.state.zoom;
        const my = (ev.clientY - rect.top - this.state.offsetY) / this.state.zoom;
        const cx1 = this._connectDragging.fromX + Math.abs(mx - this._connectDragging.fromX) * 0.5;
        const cx2 = mx - Math.abs(mx - this._connectDragging.fromX) * 0.5;
        this._connectDragging.tempPath.setAttribute(
          "d",
          `M ${this._connectDragging.fromX} ${this._connectDragging.fromY} C ${cx1} ${this._connectDragging.fromY}, ${cx2} ${my}, ${mx} ${my}`
        );
      };
      const onUp = (ev) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!this._connectDragging) return;
        this._connectDragging.tempPath.remove();
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const portEl = target?.closest("[data-port]");
        if (portEl && this._connectDragging.fromNodeId) {
          const isTargetOutput = portEl.getAttribute("data-port") === "out";
          if (isTargetOutput !== isOutput) {
            const targetNodeEl = portEl.closest(".workflow-node");
            const toNodeId = targetNodeEl?.getAttribute("data-node-id");
            const toPortIndex = parseInt(portEl.getAttribute("data-port-index") || "0");
            if (toNodeId && toNodeId !== this._connectDragging.fromNodeId) {
              const conn = {
                id: nextConnId(),
                fromNodeId: isOutput ? this._connectDragging.fromNodeId : toNodeId,
                fromPortIndex: isOutput ? this._connectDragging.fromPortIndex : toPortIndex,
                toNodeId: isOutput ? toNodeId : this._connectDragging.fromNodeId,
                toPortIndex: isOutput ? toPortIndex : this._connectDragging.fromPortIndex
              };
              this._cb.onConnectionCreated(conn);
            }
          }
        } else {
          this._cb.onConnectionDisconnect(
            this._connectDragging.sourceNodeId,
            this._connectDragging.sourcePortIndex,
            this._connectDragging.sourceIsOutput
          );
        }
        this._connectDragging = null;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
    /** Set selected connection */
    setSelectedConnection(id) {
      this._selectedConnId = id;
    }
    /** Apply view transform */
    applyView() {
      this._canvas.style.transform = `translate(${this.state.offsetX}px, ${this.state.offsetY}px) scale(${this.state.zoom})`;
    }
    /** Zoom to fit all nodes */
    zoomToFit(nodes) {
      if (nodes.length === 0) {
        this.state.zoom = 1;
        this.state.offsetX = 0;
        this.state.offsetY = 0;
        this.applyView();
        return;
      }
      const containerRect = this._container.getBoundingClientRect();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + 240);
        maxY = Math.max(maxY, n.y + 160);
      }
      const w = maxX - minX + 80, h = maxY - minY + 80;
      const scale = Math.min(containerRect.width / w, containerRect.height / h, 1.5);
      this.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
      this.state.offsetX = (containerRect.width - w * this.state.zoom) / 2 - minX * this.state.zoom + 40 * this.state.zoom;
      this.state.offsetY = (containerRect.height - h * this.state.zoom) / 2 - minY * this.state.zoom + 40 * this.state.zoom;
      this.applyView();
    }
    /** Navigate minimap click to canvas position */
    navigateToMinimapPosition(canvasClickX, canvasClickY, canvasW, canvasH, nodes) {
      if (nodes.length === 0) return;
      let minX = Math.min(...nodes.map((n) => n.x));
      let minY = Math.min(...nodes.map((n) => n.y));
      let maxX = Math.max(...nodes.map((n) => n.x + 200));
      let maxY = Math.max(...nodes.map((n) => n.y + 120));
      const bw = maxX - minX + 40;
      const bh = maxY - minY + 40;
      const scaleX = canvasW / bw;
      const scaleY = canvasH / bh;
      const scale = Math.min(scaleX, scaleY);
      const worldX = canvasClickX / scale + minX - 20;
      const worldY = canvasClickY / scale + minY - 20;
      const containerRect = this._container.getBoundingClientRect();
      this.state.offsetX = containerRect.width / 2 - worldX * this.state.zoom;
      this.state.offsetY = containerRect.height / 2 - worldY * this.state.zoom;
      this.applyView();
    }
  };

  // plugins/anoclaw-workflow/frontend/src/WorkflowList.ts
  function confirmDialog(message, title = "Confirm") {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "wf-dialog-overlay";
      overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999";
      const card = document.createElement("div");
      card.style.cssText = "background:var(--color-surface,#0d0d0d);border:1px solid var(--color-hairline,#242728);border-radius:10px;padding:24px;min-width:300px;max-width:420px;box-shadow:none";
      card.innerHTML = `<div style="font-size:14px;font-weight:600;margin-bottom:8px;color:var(--color-text,#eee)">${title}</div><div style="font-size:12px;color:var(--color-text-secondary,#999);margin-bottom:20px">${message}</div><div style="display:flex;gap:8px;justify-content:flex-end"><button id="wf-conf-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid var(--color-hairline,rgba(255,255,255,0.06));background:transparent;color:var(--color-text-secondary,#999);cursor:pointer;font-size:12px">Cancel</button><button id="wf-conf-ok" style="padding:6px 16px;border-radius:8px;border:1px solid var(--color-primary,#fff);background:var(--color-primary,#fff);color:var(--color-on-primary,#000);cursor:pointer;font-size:12px">Delete</button></div>`;
      overlay.appendChild(card);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(false);
        }
      });
      document.body.appendChild(overlay);
      card.querySelector("#wf-conf-cancel").addEventListener("click", () => {
        overlay.remove();
        resolve(false);
      });
      card.querySelector("#wf-conf-ok").addEventListener("click", () => {
        overlay.remove();
        resolve(true);
      });
    });
  }
  function buildList(workflows, activeId, cb) {
    const el = document.createElement("div");
    el.className = "workflow-list-container";
    el.innerHTML = `
    <div class="workflow-list-header">
      <span class="workflow-list-title">Workflows</span>
      <button class="workflow-list-add-btn" id="wf-list-add">+</button>
    </div>
    <div class="workflow-list-items" id="wf-list-items"></div>`;
    el.querySelector("#wf-list-add")?.addEventListener("click", () => cb.onAdd());
    const itemsEl = el.querySelector("#wf-list-items");
    for (const wf of workflows) {
      const item = document.createElement("div");
      item.className = "workflow-list-item" + (wf.id === activeId ? " active" : "");
      item.innerHTML = `
      <span style="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${wf.status === "running" ? "#f59e0b" : wf.status === "completed" ? "#10b981" : wf.status === "error" ? "#ef4444" : "rgba(255,255,255,0.15)"};${wf.status === "running" ? "animation:dotPulse 1s ease-in-out infinite;" : ""}"></span>
      <span class="workflow-list-item-name">${esc(wf.name)}</span>
      <button class="workflow-list-item-del">&times;</button>`;
      item.addEventListener("click", async (e) => {
        if (e.target.closest(".workflow-list-item-del")) {
          if (await (window.anoclaw?.dialog?.confirm || confirmDialog)('Delete workflow "' + wf.name + '"?')) cb.onDelete(wf.id);
          return;
        }
        cb.onSelect(wf.id);
      });
      itemsEl.appendChild(item);
    }
    return el;
    function esc(s) {
      const e = document.createElement("span");
      e.textContent = s;
      return e.innerHTML;
    }
  }
  var style = document.createElement("style");
  style.textContent = "@keyframes dotPulse{0%,100%{opacity:1}50%{opacity:0.3}}";
  document.head.appendChild(style);

  // plugins/anoclaw-workflow/frontend/src/WorkflowPersistence.ts
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
    }
    return { workflows: [], activeWorkflowId: null };
  }
  function loadCanvasData(wfId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY + "_" + wfId);
      if (raw) return JSON.parse(raw);
    } catch {
    }
    return null;
  }
  function saveCanvasData(wfId, data) {
    localStorage.setItem(STORAGE_KEY + "_" + wfId, JSON.stringify(data));
  }
  async function fetchWorkflows() {
    try {
      const r = await fetch("/api/v1/workflows");
      if (r.ok) {
        const d = await r.json();
        return (d.workflows || []).map((w) => ({
          id: w.id,
          name: w.name || w.id,
          status: w.status || "idle",
          createdAt: w.createdAt || "",
          lastRunAt: w.lastRunAt || null
        }));
      }
    } catch {
    }
    return [];
  }
  async function createWorkflow(name) {
    const id = "wf_" + Math.random().toString(36).slice(2, 8);
    try {
      await fetch("/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, nodes: [], connections: [], status: "idle" })
      });
      return { id, name, status: "idle", createdAt: (/* @__PURE__ */ new Date()).toISOString(), lastRunAt: null };
    } catch {
      return null;
    }
  }
  async function deleteWorkflow(id) {
    await fetch("/api/v1/workflows/" + id, { method: "DELETE" });
  }
  async function startWorkflow(id) {
    await fetch("/api/v1/workflows/" + id + "/start", { method: "POST" });
  }
  async function stopWorkflow(id) {
    await fetch("/api/v1/workflows/" + id + "/stop", { method: "POST" });
  }

  // plugins/anoclaw-workflow/frontend/src/main.ts
  var WorkflowPage = class {
    constructor() {
      __publicField(this, "name", "workflow");
      __publicField(this, "container");
      __publicField(this, "_workflows", []);
      __publicField(this, "_activeWfId", null);
      __publicField(this, "_nodes", []);
      __publicField(this, "_connections", []);
      __publicField(this, "_groups", []);
      __publicField(this, "_sessionMode", "persistent");
      __publicField(this, "_selectedNodeId", null);
      __publicField(this, "_selectedConnId", null);
      __publicField(this, "_selectedNodeIds", /* @__PURE__ */ new Set());
      // Multi-select
      // Clipboard for copy/paste
      __publicField(this, "_clipboard", null);
      // Execution logs
      __publicField(this, "_logsPanelEl", null);
      __publicField(this, "_logsVisible", false);
      __publicField(this, "_logsPollTimer", 0);
      // Search
      __publicField(this, "_searchOverlay", null);
      __publicField(this, "_searchVisible", false);
      // Execution state for flow animation
      __publicField(this, "_executionState", null);
      // DOM
      __publicField(this, "_toolbar");
      __publicField(this, "_nodeCountEl");
      __publicField(this, "_zoomLabelEl");
      __publicField(this, "_wfNameEl");
      __publicField(this, "_canvasContainer");
      __publicField(this, "_canvas");
      __publicField(this, "_svgLayer");
      __publicField(this, "_nodesLayer");
      __publicField(this, "_palette");
      __publicField(this, "_placeholder");
      __publicField(this, "_listEl", null);
      __publicField(this, "_contextMenu", null);
      __publicField(this, "_minimapCanvas");
      __publicField(this, "_ctrl");
      __publicField(this, "_initialZoomDone", false);
      __publicField(this, "_minimapTimer", 0);
      this.container = document.createElement("div");
      this.container.id = "wf-root";
      this._buildDOM();
      this._initCanvas();
      this._initKeyboardShortcuts();
      this._loadAndRender();
    }
    onEnter() {
      if (!this._initialZoomDone) {
      } else {
        this._ctrl.zoomToFit(this._nodes);
      }
    }
    onExit() {
      this._closeContextMenu();
      this._stopLogsPolling();
      this._hideSearchOverlay();
    }
    // ── Keyboard Shortcuts ──
    _initKeyboardShortcuts() {
      document.addEventListener("keydown", (e) => {
        const tag = e.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === "z" && !e.shiftKey) {
          e.preventDefault();
          this._undo();
          return;
        }
        if (ctrl && e.key === "z" && e.shiftKey || ctrl && e.key === "y") {
          e.preventDefault();
          this._redo();
          return;
        }
        if (ctrl && e.key === "c" && (this._selectedNodeId || this._selectedNodeIds.size > 0)) {
          e.preventDefault();
          this._copySelectedNodes();
          return;
        }
        if (ctrl && e.key === "v" && this._clipboard) {
          e.preventDefault();
          this._pasteNodes();
          return;
        }
        if (ctrl && e.key === "d" && (this._selectedNodeId || this._selectedNodeIds.size > 0)) {
          e.preventDefault();
          this._duplicateSelectedNode();
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          this._deleteSelected();
          return;
        }
        if (ctrl && e.key === "s") {
          e.preventDefault();
          this._showToast("Auto-saved");
          return;
        }
        if (ctrl && e.key === "f") {
          e.preventDefault();
          this._toggleSearchOverlay();
          return;
        }
        if (ctrl && e.key === "g") {
          e.preventDefault();
          this._groupSelectedNodes();
          return;
        }
        if (ctrl && e.key === "e") {
          e.preventDefault();
          this._exportWorkflow();
          return;
        }
        if (e.key === "l" && !ctrl) {
          e.preventDefault();
          this._toggleLogsPanel();
          return;
        }
        if (e.key === "Escape") {
          this._selectedNodeId = null;
          this._selectedConnId = null;
          this._selectedNodeIds.clear();
          this._updateNodeSelection();
          this._renderConnections();
          this._hideSearchOverlay();
          return;
        }
        if (ctrl && e.key === "a") {
          e.preventDefault();
          this._selectAllNodes();
          return;
        }
      });
    }
    _undo() {
      if (this._ctrl.undo()) {
        this._renderAll();
        this._showToast("Undo");
      }
    }
    _redo() {
      if (this._ctrl.redo()) {
        this._renderAll();
        this._showToast("Redo");
      }
    }
    _selectAllNodes() {
      this._selectedNodeIds.clear();
      for (const n of this._nodes) this._selectedNodeIds.add(n.id);
      this._updateNodeSelection();
      this._showToast(`Selected ${this._selectedNodeIds.size} nodes`);
    }
    _copySelectedNodes() {
      const ids = this._selectedNodeIds.size > 0 ? this._selectedNodeIds : this._selectedNodeId ? /* @__PURE__ */ new Set([this._selectedNodeId]) : /* @__PURE__ */ new Set();
      if (ids.size === 0) return;
      const copiedNodes = this._nodes.filter((n) => ids.has(n.id));
      const copiedConns = this._connections.filter((c) => ids.has(c.fromNodeId) && ids.has(c.toNodeId));
      this._clipboard = {
        nodes: JSON.parse(JSON.stringify(copiedNodes)),
        connections: JSON.parse(JSON.stringify(copiedConns))
      };
      this._showToast(`Copied ${copiedNodes.length} node(s)`);
    }
    _pasteNodes() {
      if (!this._clipboard) return;
      this._ctrl.pushState("Paste nodes");
      const idMap = /* @__PURE__ */ new Map();
      for (const node of this._clipboard.nodes) {
        const newId = nextNodeId();
        idMap.set(node.id, newId);
        const newNode = {
          ...node,
          id: newId,
          x: node.x + 30,
          y: node.y + 30,
          title: node.title,
          data: { ...node.data }
        };
        this._nodes.push(newNode);
      }
      for (const conn of this._clipboard.connections) {
        const newFrom = idMap.get(conn.fromNodeId);
        const newTo = idMap.get(conn.toNodeId);
        if (newFrom && newTo) {
          this._connections.push({
            id: "c" + ++this._ctrl._connIdSeq,
            fromNodeId: newFrom,
            fromPortIndex: conn.fromPortIndex,
            toNodeId: newTo,
            toPortIndex: conn.toPortIndex
          });
        }
      }
      this._persistCanvas();
      this._renderAll();
      this._showToast("Pasted node(s)");
    }
    _duplicateSelectedNode() {
      if (this._selectedNodeId) {
        const node = this._nodes.find((n) => n.id === this._selectedNodeId);
        if (!node) return;
        this._ctrl.pushState("Duplicate node");
        this._addNode(node.type, node.x + 30, node.y + 30);
        this._showToast("Duplicated node");
      } else if (this._selectedNodeIds.size > 0) {
        this._copySelectedNodes();
        this._pasteNodes();
      }
    }
    _deleteSelected() {
      if (this._selectedNodeIds.size > 0) {
        this._ctrl.pushState("Delete nodes");
        const ids = new Set(this._selectedNodeIds);
        this._nodes = this._nodes.filter((n) => !ids.has(n.id));
        this._connections = this._connections.filter((c) => !ids.has(c.fromNodeId) && !ids.has(c.toNodeId));
        for (const g of this._groups) {
          g.nodeIds = g.nodeIds.filter((id) => !ids.has(id));
        }
        this._selectedNodeIds.clear();
        this._selectedNodeId = null;
        this._persistCanvas();
        this._renderAll();
      } else if (this._selectedNodeId) {
        this._ctrl.pushState("Delete node");
        this._nodes = this._nodes.filter((n) => n.id !== this._selectedNodeId);
        this._connections = this._connections.filter((c) => c.fromNodeId !== this._selectedNodeId && c.toNodeId !== this._selectedNodeId);
        for (const g of this._groups) {
          g.nodeIds = g.nodeIds.filter((id) => id !== this._selectedNodeId);
        }
        this._selectedNodeId = null;
        this._persistCanvas();
        this._renderAll();
      } else if (this._selectedConnId) {
        this._ctrl.pushState("Delete connection");
        this._connections = this._connections.filter((c) => c.id !== this._selectedConnId);
        this._selectedConnId = null;
        this._persistCanvas();
        this._renderConnections();
      }
    }
    // ── Node Grouping ──
    _groupSelectedNodes() {
      const ids = this._selectedNodeIds.size > 0 ? this._selectedNodeIds : this._selectedNodeId ? /* @__PURE__ */ new Set([this._selectedNodeId]) : /* @__PURE__ */ new Set();
      if (ids.size < 2) {
        this._showToast("Select 2+ nodes to group");
        return;
      }
      this._ctrl.pushState("Group nodes");
      const groupId = nextGroupId();
      const group = {
        id: groupId,
        title: `Group ${this._groups.length + 1}`,
        nodeIds: Array.from(ids),
        collapsed: false
      };
      this._groups.push(group);
      for (const n of this._nodes) {
        if (ids.has(n.id)) n.groupId = groupId;
      }
      this._persistCanvas();
      this._renderAll();
      this._showToast(`Grouped ${ids.size} nodes`);
    }
    _ungroupNode(nodeId) {
      const node = this._nodes.find((n) => n.id === nodeId);
      if (!node?.groupId) return;
      this._ctrl.pushState("Ungroup node");
      const group = this._groups.find((g) => g.id === node.groupId);
      if (group) {
        group.nodeIds = group.nodeIds.filter((id) => id !== nodeId);
        if (group.nodeIds.length === 0) {
          this._groups = this._groups.filter((g) => g.id !== group.id);
        }
      }
      node.groupId = null;
      this._persistCanvas();
      this._renderAll();
    }
    // ── Import / Export ──
    _exportWorkflow() {
      const wf = this._workflows.find((w) => w.id === this._activeWfId);
      const data = {
        version: "3.0",
        workflow: {
          id: wf?.id,
          name: wf?.name || "Exported Workflow",
          nodes: this._nodes,
          connections: this._connections,
          groups: this._groups
        },
        exportedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(wf?.name || "workflow").replace(/[^a-zA-Z0-9]/g, "_")}.workflow.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this._showToast("Workflow exported");
    }
    _importWorkflow() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,.workflow.json";
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.workflow) {
            this._showToast("Invalid workflow file");
            return;
          }
          this._ctrl.pushState("Import workflow");
          this._nodes = data.workflow.nodes || [];
          this._connections = data.workflow.connections || [];
          this._groups = data.workflow.groups || [];
          resetIdSeqs(this._nodes, this._connections, this._groups, this._workflows);
          this._persistCanvas();
          this._renderAll();
          this._ctrl.zoomToFit(this._nodes);
          this._showToast(`Imported ${this._nodes.length} nodes`);
        } catch (err) {
          this._showToast("Failed to parse workflow file");
        }
      };
      input.click();
    }
    // ── Search ──
    _toggleSearchOverlay() {
      if (this._searchVisible) {
        this._hideSearchOverlay();
      } else {
        this._showSearchOverlay();
      }
    }
    _showSearchOverlay() {
      if (this._searchVisible) return;
      this._searchVisible = true;
      this._searchOverlay = document.createElement("div");
      this._searchOverlay.className = "workflow-search-overlay";
      this._searchOverlay.innerHTML = `
      <div class="workflow-search-panel">
        <div class="workflow-search-header">
          <span class="workflow-search-title">Search Nodes</span>
          <button class="workflow-search-close" id="wf-search-close">&times;</button>
        </div>
        <div class="workflow-search-input-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="workflow-search-input" id="wf-search-input" placeholder="Search nodes by name or type... (Ctrl+F)" autofocus>
        </div>
        <div class="workflow-search-results" id="wf-search-results"></div>
      </div>`;
      document.body.appendChild(this._searchOverlay);
      const input = this._searchOverlay.querySelector("#wf-search-input");
      const resultsEl = this._searchOverlay.querySelector("#wf-search-results");
      input.focus();
      input.addEventListener("input", () => {
        const query = input.value.toLowerCase().trim();
        this._renderSearchResults(resultsEl, query);
      });
      this._renderSearchResults(resultsEl, "");
      this._searchOverlay.querySelector("#wf-search-close")?.addEventListener("click", () => this._hideSearchOverlay());
      this._searchOverlay.addEventListener("click", (e) => {
        if (e.target === this._searchOverlay) this._hideSearchOverlay();
      });
    }
    _renderSearchResults(container, query) {
      const filtered = this._nodes.filter((n) => {
        if (!query) return true;
        return n.title.toLowerCase().includes(query) || n.type.toLowerCase().includes(query) || (NODE_DEFS[n.type]?.label || "").toLowerCase().includes(query);
      });
      if (filtered.length === 0) {
        container.innerHTML = `<div class="workflow-search-empty">${query ? "No matching nodes" : "No nodes in workflow"}</div>`;
        return;
      }
      container.innerHTML = filtered.map((n) => {
        const def = NODE_DEFS[n.type];
        return `<div class="workflow-search-item" data-node-id="${n.id}">
        <span class="workflow-search-dot" style="background:${def?.color || "#57c1ff"}"></span>
        <span class="workflow-search-name">${this._escapeHtml(n.title)}</span>
        <span class="workflow-search-type">${def?.label || n.type}</span>
      </div>`;
      }).join("");
      container.querySelectorAll(".workflow-search-item").forEach((item) => {
        item.addEventListener("click", () => {
          const nodeId = item.dataset.nodeId;
          this._selectedNodeId = nodeId;
          this._updateNodeSelection();
          const node = this._nodes.find((n) => n.id === nodeId);
          if (node) {
            const rect = this._canvasContainer.getBoundingClientRect();
            this._ctrl.state.offsetX = rect.width / 2 - node.x * this._ctrl.state.zoom - 100;
            this._ctrl.state.offsetY = rect.height / 2 - node.y * this._ctrl.state.zoom - 60;
            this._ctrl.applyView();
          }
          this._hideSearchOverlay();
        });
      });
    }
    _hideSearchOverlay() {
      this._searchVisible = false;
      if (this._searchOverlay) {
        this._searchOverlay.remove();
        this._searchOverlay = null;
      }
    }
    // ── Toast Notifications ──
    _showToast(message, duration = 1500) {
      const toast = document.createElement("div");
      toast.className = "workflow-toast";
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.2s";
        setTimeout(() => toast.remove(), 200);
      }, duration);
    }
    // ── DOM build ──
    _buildDOM() {
      const root = this.container;
      root.innerHTML = `
      <div class="workflow-page">
        <div class="workflow-toolbar" id="wf-toolbar">
          <div class="workflow-toolbar-left">
            <span class="workflow-toolbar-title" id="wf-name-display">Workflow</span>
            <span class="workflow-node-count" id="wf-node-count">0</span>
          </div>
          <div class="workflow-toolbar-center">
            <button class="workflow-zoom-btn" id="wf-zoom-out" title="Zoom Out">\u2212</button>
            <span class="workflow-zoom-label" id="wf-zoom-label">100%</span>
            <button class="workflow-zoom-btn" id="wf-zoom-in" title="Zoom In">+</button>
            <button class="workflow-zoom-btn" id="wf-zoom-fit" title="Fit to View">\u22A1</button>
          </div>
          <div class="workflow-toolbar-right" id="wf-toolbar-right"></div>
        </div>
        <div class="workflow-main" id="wf-main"></div>
      </div>`;
      this._toolbar = root.querySelector("#wf-toolbar");
      this._nodeCountEl = root.querySelector("#wf-node-count");
      this._zoomLabelEl = root.querySelector("#wf-zoom-label");
      this._wfNameEl = root.querySelector("#wf-name-display");
      const main = root.querySelector("#wf-main");
      this._canvasContainer = document.createElement("div");
      this._canvasContainer.className = "workflow-canvas-container";
      this._canvasContainer.id = "wf-canvas-container";
      this._canvas = document.createElement("div");
      this._canvas.className = "workflow-canvas";
      this._canvas.id = "wf-canvas";
      this._svgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this._svgLayer.setAttribute("class", "workflow-connections");
      this._svgLayer.style.position = "absolute";
      this._svgLayer.style.top = "0";
      this._svgLayer.style.left = "0";
      this._svgLayer.style.width = "100%";
      this._svgLayer.style.height = "100%";
      this._svgLayer.style.overflow = "visible";
      this._canvas.appendChild(this._svgLayer);
      this._nodesLayer = document.createElement("div");
      this._nodesLayer.className = "workflow-nodes-layer";
      this._nodesLayer.id = "wf-nodes-layer";
      this._canvas.appendChild(this._nodesLayer);
      this._placeholder = document.createElement("div");
      this._placeholder.className = "workflow-placeholder";
      this._placeholder.innerHTML = `<div>Drop nodes here</div><div class="workflow-placeholder-hint">Drag from palette or right-click</div>`;
      this._canvas.appendChild(this._placeholder);
      this._canvasContainer.appendChild(this._canvas);
      this._palette = document.createElement("div");
      this._palette.className = "workflow-node-palette";
      this._palette.id = "wf-palette";
      this._buildPalette();
      main.appendChild(this._canvasContainer);
      main.appendChild(this._palette);
      this._minimapCanvas = document.createElement("canvas");
      this._minimapCanvas.className = "workflow-minimap-canvas";
      this._minimapCanvas.width = 180;
      this._minimapCanvas.height = 120;
      const minimap = document.createElement("div");
      minimap.className = "workflow-minimap";
      minimap.appendChild(this._minimapCanvas);
      this._canvasContainer.appendChild(minimap);
      root.querySelector("#wf-zoom-in")?.addEventListener("click", () => {
        this._ctrl.state.zoom = Math.min(MAX_ZOOM, this._ctrl.state.zoom + 0.2);
        this._refresh();
      });
      root.querySelector("#wf-zoom-out")?.addEventListener("click", () => {
        this._ctrl.state.zoom = Math.max(MIN_ZOOM, this._ctrl.state.zoom - 0.2);
        this._refresh();
      });
      root.querySelector("#wf-zoom-fit")?.addEventListener("click", () => this._ctrl.zoomToFit(this._nodes));
    }
    _buildPalette() {
      let html = `
      <div class="workflow-palette-header">
        <span>Add Node</span>
      </div>
      <div class="workflow-palette-search-wrap">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="workflow-palette-search" id="wf-palette-search" placeholder="Filter nodes... (Ctrl+F)">
      </div>`;
      for (const group of PALETTE_GROUPS) {
        html += `<div class="workflow-palette-group-title" data-group-label="${group.label}">${group.label}</div>`;
        for (const type of group.types) {
          const def = NODE_DEFS[type];
          if (!def) continue;
          html += `
          <div class="workflow-palette-item" data-palette-type="${type}" data-palette-label="${(def.label + " " + group.label).toLowerCase()}" draggable="true">
            <span class="workflow-palette-dot" style="background:${def.color}"></span>
            <span class="workflow-palette-icon">${def.icon}</span>
            <span class="workflow-palette-label">${def.label}</span>
          </div>`;
        }
      }
      this._palette.innerHTML = html;
      const searchInput = this._palette.querySelector("#wf-palette-search");
      searchInput?.addEventListener("input", () => {
        const query = searchInput.value.toLowerCase().trim();
        this._palette.querySelectorAll(".workflow-palette-item").forEach((item) => {
          const label = item.dataset.paletteLabel || "";
          const type = item.dataset.paletteType || "";
          const matches = !query || label.includes(query) || type.includes(query);
          item.style.display = matches ? "" : "none";
        });
        this._palette.querySelectorAll(".workflow-palette-group-title").forEach((titleEl) => {
          const groupLabel = titleEl.dataset.groupLabel;
          const nextItems = PALETTE_GROUPS.find((g) => g.label === groupLabel)?.types || [];
          const hasVisible = nextItems.some((t) => {
            const itemEl = this._palette.querySelector(`[data-palette-type="${t}"]`);
            return itemEl && itemEl.style.display !== "none";
          });
          titleEl.style.display = hasVisible ? "" : "none";
        });
      });
      this._palette.querySelectorAll(".workflow-palette-item").forEach((item) => {
        item.addEventListener("dragstart", (e) => {
          const type = item.dataset.paletteType;
          e.dataTransfer?.setData("text/plain", type);
        });
        item.addEventListener("click", () => {
          const type = item.dataset.paletteType;
          const w = this._canvasContainer.clientWidth;
          const h = this._canvasContainer.clientHeight;
          const cx = (w / 2 - this._ctrl.state.offsetX) / this._ctrl.state.zoom;
          const cy = (h / 2 - this._ctrl.state.offsetY) / this._ctrl.state.zoom;
          this._addNode(type, Math.round(cx - 100), Math.round(cy - 30));
        });
      });
      this._canvasContainer.addEventListener("dragover", (e) => e.preventDefault());
      this._canvasContainer.addEventListener("drop", (e) => {
        e.preventDefault();
        const type = e.dataTransfer?.getData("text/plain");
        if (!type) return;
        const rect = this._canvasContainer.getBoundingClientRect();
        let x = (e.clientX - rect.left - this._ctrl.state.offsetX) / this._ctrl.state.zoom;
        let y = (e.clientY - rect.top - this._ctrl.state.offsetY) / this._ctrl.state.zoom;
        if (this._ctrl.snapToGrid) {
          x = Math.round(x / GRID_SIZE) * GRID_SIZE;
          y = Math.round(y / GRID_SIZE) * GRID_SIZE;
        }
        this._addNode(type, Math.round(x - 100), Math.round(y - 30));
      });
    }
    // ── Canvas init ──
    _initCanvas() {
      const callbacks = {
        getNodes: () => this._nodes,
        getConnections: () => this._connections,
        onNodeMoved: (id, x, y) => {
          const n = this._nodes.find((n2) => n2.id === id);
          if (n) {
            n.x = x;
            n.y = y;
          }
        },
        onConnectionCreated: (conn) => {
          this._ctrl.pushState("Create connection");
          this._connections.push(conn);
          this._persistCanvas();
          this._renderConnections();
        },
        onConnectionDisconnect: (nodeId, portIndex, isOutput) => {
          const before = this._connections.length;
          this._connections = this._connections.filter(
            (c) => isOutput ? !(c.fromNodeId === nodeId && c.fromPortIndex === portIndex) : !(c.toNodeId === nodeId && c.toPortIndex === portIndex)
          );
          if (this._connections.length < before) {
            this._ctrl.pushState("Disconnect");
            this._persistCanvas();
            this._renderConnections();
          }
        },
        onConnectionSelected: (id) => {
          this._selectedConnId = id;
          this._selectedNodeId = null;
          this._renderConnections();
        },
        onNodeSelected: (id) => {
          this._selectedNodeId = id;
          this._selectedConnId = null;
          this._updateNodeSelection();
        },
        onCanvasContextMenu: (x, y) => this._showCanvasContextMenu(x, y),
        onNodeContextMenu: (id, x, y) => this._showNodeContextMenu(id, x, y),
        onUpdateView: () => this._refresh(),
        onStateChange: () => this._updateUndoRedoButtons()
      };
      this._ctrl = new WorkflowCanvasController(this._canvasContainer, this._canvas, this._svgLayer, callbacks);
      this._canvasContainer.addEventListener("contextmenu", (e) => {
        const target = e.target;
        const nodeEl = target.closest(".workflow-node");
        if (nodeEl) {
          e.preventDefault();
          const nodeId = nodeEl.getAttribute("data-node-id");
          this._showNodeContextMenu(nodeId, e.clientX, e.clientY);
        } else if (target.closest(".workflow-conn-path") || target.closest(".workflow-conn-hitarea")) {
          e.preventDefault();
          this._showConnContextMenu(e.clientX, e.clientY);
        } else if (!target.closest(".workflow-list-container")) {
          e.preventDefault();
          this._showCanvasContextMenu(e.clientX, e.clientY);
        }
      });
      this._nodesLayer.addEventListener("mousedown", (e) => {
        const nodeEl = e.target.closest(".workflow-node");
        if (!nodeEl) return;
        e.stopPropagation();
        const nodeId = nodeEl.getAttribute("data-node-id");
        const node = this._nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const portEl = e.target.closest("[data-port]");
        if (portEl) {
          const isOutput = portEl.getAttribute("data-port") === "out";
          const portIndex = parseInt(portEl.getAttribute("data-port-index") || "0");
          this._ctrl.startPortConnect(nodeId, portIndex, isOutput, e);
          return;
        }
        if (e.target.closest(".workflow-node-delete") || e.target.closest("textarea") || e.target.closest("select") || e.target.closest("input")) return;
        if (e.shiftKey) {
          if (this._selectedNodeIds.has(nodeId)) {
            this._selectedNodeIds.delete(nodeId);
          } else {
            this._selectedNodeIds.add(nodeId);
          }
          this._selectedNodeId = null;
          this._selectedConnId = null;
          this._updateNodeSelection();
          return;
        }
        this._selectedNodeId = nodeId;
        this._selectedConnId = null;
        this._selectedNodeIds.clear();
        this._updateNodeSelection();
        const startX = node.x, startY = node.y;
        const origNode = { x: node.x, y: node.y };
        const origDrag = { active: true };
        this._ctrl.startNodeDrag(nodeId, node.x, node.y, e);
        const onUp = () => {
          window.removeEventListener("mouseup", onUp);
          if (origDrag.active) {
            origDrag.active = false;
            const moved = this._nodes.find((n) => n.id === nodeId);
            if (moved && (moved.x !== origNode.x || moved.y !== origNode.y)) {
              this._ctrl.pushState("Move node");
            }
          }
        };
        window.addEventListener("mouseup", onUp);
      });
      renderMinimap(this._minimapCanvas, this._nodes, this._connections, 0, 0, 0, 0, 1, this._groups, (cx, cy, cw, ch) => {
        this._ctrl.navigateToMinimapPosition(cx, cy, cw, ch, this._nodes);
      });
    }
    // ── Data ──
    /** Save canvas to API before executing */
    _saveToApi() {
      if (!this._activeWfId) return Promise.resolve();
      return fetch("/api/v1/workflows/" + this._activeWfId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodes: this._nodes,
          connections: this._connections,
          groups: this._groups,
          sessionMode: this._sessionMode
        })
      }).then(() => {
      }).catch(() => {
      });
    }
    async _loadAndRender() {
      const apiWfs = await fetchWorkflows();
      if (apiWfs.length > 0) {
        this._workflows = apiWfs;
        if (!this._activeWfId || !this._workflows.find((w) => w.id === this._activeWfId)) {
          this._activeWfId = apiWfs[0].id;
        }
      } else {
        const store = loadStore();
        this._workflows = store.workflows;
        this._activeWfId = store.activeWorkflowId || (store.workflows[0]?.id || null);
      }
      if (!this._activeWfId && this._workflows.length === 0) {
        const wf = await createWorkflow("My Workflow");
        if (wf) {
          this._workflows = [wf];
          this._activeWfId = wf.id;
        }
      }
      await this._loadCanvas();
      this._renderAll();
    }
    async _loadCanvas() {
      if (!this._activeWfId) {
        this._nodes = [];
        this._connections = [];
        this._groups = [];
        return;
      }
      const data = loadCanvasData(this._activeWfId);
      if (data) {
        this._nodes = data.nodes || [];
        this._connections = data.connections || [];
        this._groups = data.groups || [];
        this._sessionMode = data.sessionMode === "ephemeral" ? "ephemeral" : "persistent";
        resetIdSeqs(this._nodes, this._connections, this._groups, this._workflows);
        return;
      }
      try {
        const r = await fetch("/api/v1/workflows/" + this._activeWfId);
        if (r.ok) {
          const wf = await r.json();
          if (wf.nodes && wf.nodes.length > 0) {
            this._nodes = wf.nodes || [];
            this._connections = wf.connections || [];
            this._groups = wf.groups || [];
            resetIdSeqs(this._nodes, this._connections, this._groups, this._workflows);
            saveCanvasData(this._activeWfId, { nodes: this._nodes, connections: this._connections, groups: this._groups });
            return;
          }
        }
      } catch {
      }
      this._nodes = [];
      this._connections = [];
      this._groups = [];
    }
    _persistCanvas() {
      if (!this._activeWfId) return;
      saveCanvasData(this._activeWfId, { nodes: this._nodes, connections: this._connections, groups: this._groups, sessionMode: this._sessionMode });
    }
    // ── Render ──
    _renderAll() {
      this._renderToolbar();
      this._renderList();
      this._renderNodes();
      this._renderConnections();
      this._renderGroups();
      this._updatePlaceholder();
      this._ctrl.applyView();
      this._updateMinimap();
      this._updateUndoRedoButtons();
      if (!this._initialZoomDone && this._nodes.length > 0) {
        this._initialZoomDone = true;
        this._ctrl.zoomToFit(this._nodes);
      } else if (!this._initialZoomDone) {
        this._initialZoomDone = true;
      }
    }
    _refresh() {
      this._ctrl.applyView();
      this._zoomLabelEl.textContent = Math.round(this._ctrl.state.zoom * 100) + "%";
      if (!this._minimapTimer) {
        this._minimapTimer = requestAnimationFrame(() => {
          this._minimapTimer = 0;
          this._updateMinimap();
        });
      }
    }
    _renderToolbar() {
      const wf = this._workflows.find((w) => w.id === this._activeWfId);
      this._wfNameEl.textContent = wf?.name || "No workflow";
      this._nodeCountEl.textContent = String(this._nodes.length);
      this._zoomLabelEl.textContent = Math.round(this._ctrl.state.zoom * 100) + "%";
      const right = this._toolbar.querySelector("#wf-toolbar-right");
      const status = wf?.status || "idle";
      const isSnap = this._ctrl.snapToGrid;
      right.innerHTML = `
      ${status === "idle" ? '<button class="plugin-btn" id="wf-run-btn" style="color:#59d499;border-color:rgba(89,212,153,0.3);">Run</button>' : ""}
      ${status === "running" ? '<button class="plugin-btn plugin-btn-danger" id="wf-stop-btn">Stop</button>' : ""}
      <button class="workflow-zoom-btn" id="wf-logs-btn" title="Toggle Logs (L)" style="font-size:12px;width:auto;padding:0 6px;">\u{1F4CB}</button>
      <button class="workflow-zoom-btn" id="wf-undo-btn" title="Undo (Ctrl+Z)" style="font-size:12px;width:auto;padding:0 6px;opacity:0.4;">\u21B6</button>
      <button class="workflow-zoom-btn" id="wf-redo-btn" title="Redo (Ctrl+Shift+Z)" style="font-size:12px;width:auto;padding:0 6px;opacity:0.4;">\u21B7</button>
            <button class="workflow-zoom-btn ${isSnap ? "active" : ""}" id="wf-snap-btn" title="Toggle Snap to Grid" style="font-size:11px;width:auto;padding:0 6px;${isSnap ? "color:var(--color-text);border-color:var(--color-hairline-strong);background:var(--color-surface-elevated);" : ""}">\u229E</button>
      <button class="workflow-zoom-btn" id="wf-search-btn" title="Search (Ctrl+F)" style="font-size:12px;width:auto;padding:0 6px;">\u{1F50D}</button>
      <button class="workflow-zoom-btn" id="wf-import-btn" title="Import Workflow" style="font-size:12px;width:auto;padding:0 6px;">\u{1F4C2}</button>
      <button class="workflow-zoom-btn" id="wf-export-btn" title="Export Workflow (Ctrl+E)" style="font-size:12px;width:auto;padding:0 6px;">\u{1F4BE}</button>
      <span class="workflow-status-badge" style="background:${status === "running" ? "rgba(255,197,51,0.12)" : status === "completed" ? "rgba(89,212,153,0.12)" : status === "error" ? "rgba(255,97,97,0.12)" : "rgba(255,255,255,0.06)"};color:${status === "running" ? "#ffc533" : status === "completed" ? "#59d499" : status === "error" ? "#ff6161" : "var(--color-text-tertiary)"};">${status}</span>
      <select id="wf-session-mode" style="margin-left:4px;font-size:10px;background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-hairline);border-radius:6px;padding:2px 4px;">
        <option value="persistent" ${this._sessionMode === "persistent" ? "selected" : ""}>Persistent session</option>
        <option value="ephemeral" ${this._sessionMode === "ephemeral" ? "selected" : ""}>Ephemeral session</option>
      </select>`;
      right.querySelector("#wf-run-btn")?.addEventListener("click", async () => {
        if (this._activeWfId) {
          await this._saveToApi();
          startWorkflow(this._activeWfId).then(() => this._loadAndRender());
        }
      });
      right.querySelector("#wf-stop-btn")?.addEventListener("click", () => {
        if (this._activeWfId) stopWorkflow(this._activeWfId).then(() => this._loadAndRender());
      });
      right.querySelector("#wf-session-mode")?.addEventListener("change", async (e) => {
        this._sessionMode = e.target.value;
        this._persistCanvas();
        await this._saveToApi();
      });
      right.querySelector("#wf-logs-btn")?.addEventListener("click", () => this._toggleLogsPanel());
      right.querySelector("#wf-undo-btn")?.addEventListener("click", () => this._undo());
      right.querySelector("#wf-redo-btn")?.addEventListener("click", () => this._redo());
      right.querySelector("#wf-snap-btn")?.addEventListener("click", () => {
        this._ctrl.toggleSnapToGrid();
        this._renderToolbar();
        this._showToast(this._ctrl.snapToGrid ? "Snap-to-grid ON" : "Snap-to-grid OFF");
      });
      right.querySelector("#wf-search-btn")?.addEventListener("click", () => this._toggleSearchOverlay());
      right.querySelector("#wf-import-btn")?.addEventListener("click", () => this._importWorkflow());
      right.querySelector("#wf-export-btn")?.addEventListener("click", () => this._exportWorkflow());
      this._updateUndoRedoButtons();
    }
    _updateUndoRedoButtons() {
      const undoBtn = this._toolbar.querySelector("#wf-undo-btn");
      const redoBtn = this._toolbar.querySelector("#wf-redo-btn");
      if (undoBtn) undoBtn.style.opacity = this._ctrl.canUndo ? "1" : "0.4";
      if (redoBtn) redoBtn.style.opacity = this._ctrl.canRedo ? "1" : "0.4";
    }
    _renderList() {
      const main = this.container.querySelector("#wf-main");
      if (this._listEl) this._listEl.remove();
      this._listEl = buildList(this._workflows, this._activeWfId, {
        onSelect: async (id) => {
          this._activeWfId = id;
          await this._loadCanvas();
          this._renderAll();
        },
        onAdd: async () => {
          const wf = await createWorkflow("New Workflow");
          if (wf) {
            this._workflows.push(wf);
            this._activeWfId = wf.id;
            await this._loadCanvas();
            this._renderAll();
          }
        },
        onDelete: async (id) => {
          await deleteWorkflow(id);
          this._workflows = this._workflows.filter((w) => w.id !== id);
          if (this._activeWfId === id) {
            this._activeWfId = this._workflows[0]?.id || null;
            await this._loadCanvas();
          }
          this._renderAll();
        }
      });
      main.insertBefore(this._listEl, this._canvasContainer);
    }
    _renderNodes() {
      this._nodesLayer.innerHTML = "";
      for (const node of this._nodes) {
        if (node.groupId) {
          const group = this._groups.find((g) => g.id === node.groupId);
          if (group?.collapsed) continue;
        }
        const el = renderNode(node, node.id === this._selectedNodeId, {
          onMoveStart: (e) => {
            this._selectedNodeId = node.id;
            this._selectedConnId = null;
            this._selectedNodeIds.clear();
            this._updateNodeSelection();
            this._ctrl.startNodeDrag(node.id, node.x, node.y, e);
          },
          onDelete: () => {
            this._ctrl.pushState("Delete node");
            this._nodes = this._nodes.filter((n) => n.id !== node.id);
            this._connections = this._connections.filter((c) => c.fromNodeId !== node.id && c.toNodeId !== node.id);
            this._persistCanvas();
            this._renderAll();
          },
          onTitleChange: (title) => {
            node.title = title;
            this._persistCanvas();
          },
          onParamChange: (key, value) => {
            this._ctrl.pushState("Change parameter");
            node.data = node.data || {};
            node.data[key] = value;
            this._persistCanvas();
          },
          onPortMouseDown: (portIndex, isOutput, e) => this._ctrl.startPortConnect(node.id, portIndex, isOutput, e)
        }, this._selectedNodeIds);
        this._nodesLayer.appendChild(el);
      }
    }
    /** Lightweight selection update - toggle class without full DOM rebuild */
    _updateNodeSelection() {
      this._nodesLayer.querySelectorAll(".workflow-node").forEach((el) => {
        const id = el.getAttribute("data-node-id");
        el.classList.toggle("workflow-node-selected", id === this._selectedNodeId);
        el.classList.toggle("workflow-node-multi-selected", !!id && this._selectedNodeIds.has(id));
      });
    }
    _renderConnections() {
      renderConnections(this._svgLayer, this._connections, this._nodes, this._selectedConnId, (id) => {
        this._selectedConnId = id;
        this._selectedNodeId = null;
        this._renderConnections();
      }, this._executionState, this._nodesLayer, this._ctrl.state.zoom);
    }
    _renderGroups() {
      this._nodesLayer.querySelectorAll(".workflow-group-container").forEach((el) => el.remove());
      for (const group of this._groups) {
        if (group.collapsed) {
          const groupNodes = this._nodes.filter((n) => group.nodeIds.includes(n.id));
          if (groupNodes.length === 0) continue;
          const minX = Math.min(...groupNodes.map((n) => n.x));
          const minY = Math.min(...groupNodes.map((n) => n.y));
          const maxX = Math.max(...groupNodes.map((n) => n.x + 200));
          const maxY = Math.max(...groupNodes.map((n) => n.y + 120));
          const padding = 16;
          const container = document.createElement("div");
          container.className = "workflow-group-container workflow-group-collapsed";
          container.style.left = minX - padding + "px";
          container.style.top = minY - padding - 28 + "px";
          container.style.width = maxX - minX + padding * 2 + "px";
          container.style.height = maxY - minY + padding * 2 + 28 + "px";
          container.innerHTML = `
          <div class="workflow-group-header">
            <span class="workflow-group-title">${this._escapeHtml(group.title)}</span>
            <span class="workflow-group-count">${groupNodes.length} nodes</span>
            <button class="workflow-group-expand" title="Expand">&times;</button>
          </div>`;
          container.querySelector(".workflow-group-expand")?.addEventListener("click", () => {
            this._ctrl.pushState("Expand group");
            group.collapsed = false;
            this._persistCanvas();
            this._renderAll();
          });
          container.addEventListener("dblclick", () => {
            this._ctrl.pushState("Expand group");
            group.collapsed = false;
            this._persistCanvas();
            this._renderAll();
          });
          this._nodesLayer.appendChild(container);
        } else {
          const groupNodes = this._nodes.filter((n) => group.nodeIds.includes(n.id));
          if (groupNodes.length === 0) continue;
          const minX = Math.min(...groupNodes.map((n) => n.x));
          const minY = Math.min(...groupNodes.map((n) => n.y));
          const maxX = Math.max(...groupNodes.map((n) => n.x + 200));
          const maxY = Math.max(...groupNodes.map((n) => n.y + 120));
          const padding = 12;
          const container = document.createElement("div");
          container.className = "workflow-group-container workflow-group-expanded";
          container.style.left = minX - padding + "px";
          container.style.top = minY - padding - 24 + "px";
          container.style.width = maxX - minX + padding * 2 + "px";
          container.style.height = maxY - minY + padding * 2 + 24 + "px";
          container.innerHTML = `
          <div class="workflow-group-header">
            <span class="workflow-group-title">${this._escapeHtml(group.title)}</span>
            <button class="workflow-group-collapse" title="Collapse">\u2212</button>
          </div>`;
          container.querySelector(".workflow-group-collapse")?.addEventListener("click", () => {
            this._ctrl.pushState("Collapse group");
            group.collapsed = true;
            this._persistCanvas();
            this._renderAll();
          });
          this._nodesLayer.appendChild(container);
        }
      }
    }
    _updatePlaceholder() {
      this._placeholder.style.display = this._nodes.length === 0 ? "" : "none";
    }
    _updateMinimap() {
      const containerRect = this._canvasContainer.getBoundingClientRect();
      renderMinimap(this._minimapCanvas, this._nodes, this._connections, containerRect.width, containerRect.height, this._ctrl.state.offsetX, this._ctrl.state.offsetY, this._ctrl.state.zoom, this._groups);
    }
    // ── Execution Logs Panel ──
    _toggleLogsPanel() {
      if (this._logsVisible) {
        this._hideLogsPanel();
      } else {
        this._showLogsPanel();
      }
    }
    _showLogsPanel() {
      if (this._logsVisible) return;
      this._logsVisible = true;
      this._logsPanelEl = document.createElement("div");
      this._logsPanelEl.className = "workflow-logs-panel";
      this._logsPanelEl.innerHTML = `
      <div class="workflow-logs-header">
        <span class="workflow-logs-header-title">Execution Logs</span>
        <div class="workflow-logs-header-actions">
          <button class="workflow-logs-header-btn" id="wf-logs-refresh" title="Refresh">\u21BB</button>
          <button class="workflow-logs-header-btn" id="wf-logs-clear" title="Clear">\u2715</button>
          <button class="workflow-logs-header-btn" id="wf-logs-close" title="Close">\u2212</button>
        </div>
      </div>
      <div class="workflow-logs-body" id="wf-logs-body">
        <div style="padding:12px;color:var(--color-text-tertiary);">No logs yet. Run a workflow to see execution logs.</div>
      </div>`;
      this._canvasContainer.appendChild(this._logsPanelEl);
      this._logsPanelEl.querySelector("#wf-logs-close")?.addEventListener("click", () => this._hideLogsPanel());
      this._logsPanelEl.querySelector("#wf-logs-clear")?.addEventListener("click", () => {
        const body = this._logsPanelEl?.querySelector("#wf-logs-body");
        if (body) body.innerHTML = '<div style="padding:12px;color:var(--color-text-tertiary);">Logs cleared.</div>';
      });
      this._logsPanelEl.querySelector("#wf-logs-refresh")?.addEventListener("click", () => this._fetchLogs());
      this._fetchLogs();
      this._startLogsPolling();
    }
    _hideLogsPanel() {
      this._logsVisible = false;
      this._stopLogsPolling();
      if (this._logsPanelEl) {
        this._logsPanelEl.remove();
        this._logsPanelEl = null;
      }
    }
    _startLogsPolling() {
      this._stopLogsPolling();
      this._logsPollTimer = window.setInterval(() => {
        const wf = this._workflows.find((w) => w.id === this._activeWfId);
        if (wf?.status === "running") {
          this._fetchLogs();
        }
      }, 2e3);
    }
    _stopLogsPolling() {
      if (this._logsPollTimer) {
        clearInterval(this._logsPollTimer);
        this._logsPollTimer = 0;
      }
    }
    async _fetchLogs() {
      if (!this._activeWfId) return;
      try {
        const r = await fetch(`/api/v1/workflows/${this._activeWfId}/logs`);
        if (!r.ok) return;
        const data = await r.json();
        const logs = data.logs || [];
        const execState = data.executionState;
        this._executionState = execState;
        if (execState?.nodeResults) {
          for (const node of this._nodes) {
            if (execState.currentNodeId === node.id && execState.status === "running") {
              node.status = "running";
            } else if (execState.nodeResults[node.id] !== void 0) {
              const result = execState.nodeResults[node.id];
              node.status = result?.error ? "error" : "success";
            } else {
              node.status = "idle";
            }
          }
          this._renderNodes();
          this._renderConnections();
        }
        const body = this._logsPanelEl?.querySelector("#wf-logs-body");
        if (!body) return;
        if (logs.length === 0) {
          body.innerHTML = '<div style="padding:12px;color:var(--color-text-tertiary);">No logs yet. Run a workflow to see execution logs.</div>';
          return;
        }
        let html = "";
        if (execState?.status === "running" && execState?.currentNodeId) {
          const currentNode = this._nodes.find((n) => n.id === execState.currentNodeId);
          html += `<div class="workflow-log-entry" style="background:rgba(255,197,51,0.08);position:sticky;top:0;">
          <span class="workflow-log-level" style="color:#ffc533;">RUN</span>
          <span class="workflow-log-msg">Running: ${currentNode?.title || execState.currentNodeId}</span>
        </div>`;
        }
        for (const log of logs) {
          const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : "";
          const level = log.level || "info";
          const msg = log.message || JSON.stringify(log);
          html += `<div class="workflow-log-entry">
          <span class="workflow-log-time">${time}</span>
          <span class="workflow-log-level ${level}">${level}</span>
          <span class="workflow-log-msg">${this._escapeHtml(msg)}</span>
        </div>`;
        }
        body.innerHTML = html;
        body.scrollTop = body.scrollHeight;
      } catch {
      }
    }
    _escapeHtml(s) {
      const el = document.createElement("span");
      el.textContent = s;
      return el.innerHTML;
    }
    // ── Node operations ──
    _addNode(type, x, y) {
      const def = NODE_DEFS[type];
      if (!def) return;
      let posX = Math.max(0, x);
      let posY = Math.max(0, y);
      if (this._ctrl.snapToGrid) {
        posX = Math.round(posX / GRID_SIZE) * GRID_SIZE;
        posY = Math.round(posY / GRID_SIZE) * GRID_SIZE;
      }
      const node = {
        id: nextNodeId(),
        type,
        x: posX,
        y: posY,
        title: def.defaultTitle,
        description: "",
        status: "idle",
        params: {},
        groupId: null,
        inputLabels: [...def.inputLabels],
        outputLabels: [...def.outputLabels]
      };
      this._nodes.push(node);
      this._selectedNodeId = node.id;
      this._ctrl.pushState(`Add ${def.label}`);
      this._persistCanvas();
      const el = renderNode(node, true, {
        onMoveStart: (e) => {
          this._selectedNodeId = node.id;
          this._selectedConnId = null;
          this._updateNodeSelection();
          this._ctrl.startNodeDrag(node.id, node.x, node.y, e);
        },
        onDelete: () => {
          this._ctrl.pushState("Delete node");
          this._nodes = this._nodes.filter((n) => n.id !== node.id);
          this._connections = this._connections.filter((c) => c.fromNodeId !== node.id && c.toNodeId !== node.id);
          this._persistCanvas();
          this._renderAll();
        },
        onTitleChange: (title) => {
          node.title = title;
          this._persistCanvas();
        },
        onParamChange: (key, value) => {
          this._ctrl.pushState("Change parameter");
          node.data = node.data || {};
          node.data[key] = value;
          this._persistCanvas();
        },
        onPortMouseDown: (portIndex, isOutput, e) => this._ctrl.startPortConnect(node.id, portIndex, isOutput, e)
      }, this._selectedNodeIds);
      this._updateNodeSelection();
      this._nodesLayer.appendChild(el);
      this._nodeCountEl.textContent = String(this._nodes.length);
      this._updatePlaceholder();
      this._renderConnections();
      this._updateMinimap();
      this._ctrl.applyView();
    }
    // ── Context menus ──
    _showCanvasContextMenu(x, y) {
      this._closeContextMenu();
      const menu = document.createElement("div");
      menu.className = "workflow-context-menu";
      menu.style.left = x + "px";
      menu.style.top = y + "px";
      let html = "";
      for (const group of PALETTE_GROUPS) {
        for (const type of group.types) {
          const def = NODE_DEFS[type];
          if (!def) continue;
          html += `<div class="workflow-context-item" data-action="add-${type}">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${def.color};margin-right:6px;"></span>
          ${def.label}
        </div>`;
        }
      }
      html += '<div class="workflow-context-divider"></div>';
      html += '<div class="workflow-context-item" data-action="import">Import Workflow</div>';
      html += '<div class="workflow-context-item" data-action="export">Export Workflow</div>';
      if (this._nodes.length > 0) html += '<div class="workflow-context-item" data-action="fit">Fit to View</div>';
      menu.innerHTML = html;
      document.body.appendChild(menu);
      this._contextMenu = menu;
      menu.querySelectorAll("[data-action]").forEach((item) => {
        item.addEventListener("click", () => {
          const action = item.dataset.action;
          this._closeContextMenu();
          if (action === "fit") {
            this._ctrl.zoomToFit(this._nodes);
            return;
          }
          if (action === "import") {
            this._importWorkflow();
            return;
          }
          if (action === "export") {
            this._exportWorkflow();
            return;
          }
          const rect = this._canvasContainer.getBoundingClientRect();
          const cx = (x - rect.left - this._ctrl.state.offsetX) / this._ctrl.state.zoom;
          const cy = (y - rect.top - this._ctrl.state.offsetY) / this._ctrl.state.zoom;
          this._addNode(action.replace("add-", ""), cx - 100, cy - 30);
        });
      });
      setTimeout(() => document.addEventListener("click", () => this._closeContextMenu(), { once: true }), 0);
    }
    _showNodeContextMenu(nodeId, x, y) {
      this._closeContextMenu();
      const node = this._nodes.find((n) => n.id === nodeId);
      const hasGroup = node?.groupId;
      const menu = document.createElement("div");
      menu.className = "workflow-context-menu";
      menu.style.left = x + "px";
      menu.style.top = y + "px";
      menu.innerHTML = `
      <div class="workflow-context-item" data-action="duplicate">Duplicate</div>
      <div class="workflow-context-item" data-action="copy">Copy <span class="workflow-shortcut-hint">Ctrl+C</span></div>
      ${hasGroup ? '<div class="workflow-context-item" data-action="ungroup">Ungroup</div>' : ""}
      <div class="workflow-context-divider"></div>
      <div class="workflow-context-item workflow-context-item-danger" data-action="delete">Delete Node <span class="workflow-shortcut-hint">Del</span></div>`;
      document.body.appendChild(menu);
      this._contextMenu = menu;
      menu.querySelector('[data-action="duplicate"]')?.addEventListener("click", () => {
        this._closeContextMenu();
        const node2 = this._nodes.find((n) => n.id === nodeId);
        if (node2) {
          this._ctrl.pushState("Duplicate node");
          this._addNode(node2.type, node2.x + 30, node2.y + 30);
        }
      });
      menu.querySelector('[data-action="copy"]')?.addEventListener("click", () => {
        this._closeContextMenu();
        this._selectedNodeId = nodeId;
        this._copySelectedNodes();
      });
      menu.querySelector('[data-action="ungroup"]')?.addEventListener("click", () => {
        this._closeContextMenu();
        this._ungroupNode(nodeId);
      });
      menu.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
        this._closeContextMenu();
        this._ctrl.pushState("Delete node");
        this._nodes = this._nodes.filter((n) => n.id !== nodeId);
        this._connections = this._connections.filter((c) => c.fromNodeId !== nodeId && c.toNodeId !== nodeId);
        this._persistCanvas();
        this._renderAll();
      });
      setTimeout(() => document.addEventListener("click", () => this._closeContextMenu(), { once: true }), 0);
    }
    _showConnContextMenu(x, y) {
      this._closeContextMenu();
      const menu = document.createElement("div");
      menu.className = "workflow-context-menu";
      menu.style.left = x + "px";
      menu.style.top = y + "px";
      menu.innerHTML = `
      <div class="workflow-context-item workflow-context-item-danger" data-action="delete-conn">Delete Connection <span class="workflow-shortcut-hint">Del</span></div>`;
      document.body.appendChild(menu);
      this._contextMenu = menu;
      menu.querySelector('[data-action="delete-conn"]')?.addEventListener("click", () => {
        this._closeContextMenu();
        this._ctrl.pushState("Delete connection");
        this._connections = this._connections.filter((c) => c.id !== this._selectedConnId);
        this._selectedConnId = null;
        this._persistCanvas();
        this._renderConnections();
      });
      setTimeout(() => document.addEventListener("click", () => this._closeContextMenu(), { once: true }), 0);
    }
    _closeContextMenu() {
      if (this._contextMenu) {
        this._contextMenu.remove();
        this._contextMenu = null;
      }
    }
  };
  var page = new WorkflowPage();
  document.body.appendChild(page.container);
  page.onEnter();
})();
