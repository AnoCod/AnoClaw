// Agent identity, configuration, and runtime types
export var AgentRole;
(function (AgentRole) {
    AgentRole["MainAgent"] = "MainAgent";
    AgentRole["Manager"] = "Manager";
    AgentRole["Member"] = "Member";
    AgentRole["SubAgent"] = "SubAgent";
})(AgentRole || (AgentRole = {}));
export var AgentState;
(function (AgentState) {
    AgentState["Active"] = "Active";
    AgentState["Idle"] = "Idle";
    AgentState["Destroyed"] = "Destroyed";
})(AgentState || (AgentState = {}));
export var AgentStatus;
(function (AgentStatus) {
    AgentStatus["Working"] = "Working";
    AgentStatus["WaitingTool"] = "WaitingTool";
    AgentStatus["Paused"] = "Paused";
    AgentStatus["Error"] = "Error";
})(AgentStatus || (AgentStatus = {}));
export var OrgRole;
(function (OrgRole) {
    OrgRole["Manager"] = "Manager";
    OrgRole["Member"] = "Member";
})(OrgRole || (OrgRole = {}));
//# sourceMappingURL=agent.js.map