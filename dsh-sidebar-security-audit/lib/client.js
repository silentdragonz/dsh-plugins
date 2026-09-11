window.__ModuleLoader__.load({
	id: "dsh-sidebar-security-audit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		const API = "/api/dsh-sidebar-security-audit";
		async function getJson(path, params) {
			const query = new URLSearchParams(params).toString();
			const resp = await fetch(query.length > 0 ? `${API}${path}?${query}` : `${API}${path}`, {
				method: "GET",
				headers: { accept: "application/json" }
			});
			const body = await resp.json().catch(() => void 0);
			if (!resp.ok) {
				const message = body !== null && typeof body === "object" && "error" in body ? String(body.error) : `HTTP ${resp.status}`;
				throw new Error(message);
			}
			return body;
		}
		const api = {
			/** List audit runs (default root when omitted). */
			runs: (root) => getJson("/runs", root !== void 0 && root !== "" ? { root } : {}),
			/** Raw findings.json content for one run directory (contained in `root`). */
			findings: (dir, root) => getJson("/findings", {
				dir,
				root
			}),
			/** Raw text of one whitelisted artifact file (REPORT.md etc.). */
			report: (dir, file, root) => getJson("/report", {
				dir,
				file,
				root
			})
		};
		//#endregion
		//#region src/client/types.ts
		function isConfirmed(finding) {
			return finding.verdict === "confirmed";
		}
		/** Parse findings.json content leniently; returns the finding list. */
		function parseFindings(content) {
			try {
				const parsed = JSON.parse(content);
				if (!Array.isArray(parsed)) return {
					findings: [],
					parseError: "findings.json is not an array"
				};
				return { findings: parsed };
			} catch (e) {
				return {
					findings: [],
					parseError: e instanceof Error ? e.message : String(e)
				};
			}
		}
		//#endregion
		//#region src/client/severity.ts
		const SEVERITY_ORDER = [
			"critical",
			"high",
			"medium",
			"low",
			"informational"
		];
		const SEVERITY_COLORS = {
			critical: "#e5484d",
			high: "#f76b15",
			medium: "#e8b931",
			low: "#46a758",
			informational: "#8d8d8d"
		};
		const SEVERITY_LABELS = {
			critical: "Critical",
			high: "High",
			medium: "Medium",
			low: "Low",
			informational: "Info"
		};
		/** Coerce any severity-ish string to a known severity (default informational). */
		function asSeverity(value) {
			return typeof value === "string" && SEVERITY_ORDER.includes(value) ? value : "informational";
		}
		//#endregion
		//#region src/client/FindingCard.tsx
		/**
		* One finding card: severity/confidence badges, collapsible sections for
		* description, root cause, trace, conditions, execution and remediation.
		* Rejected findings render collapsed with the rejection reason.
		*/
		function Badge(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsa-badge",
				style: { background: props.color },
				children: props.label
			});
		}
		function Section(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				className: "dsa-sec",
				open: props.defaultOpen || void 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: props.title }), props.children]
			});
		}
		function TraceList(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
				className: "dsa-trace",
				children: props.steps.map((step, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
					step.kind !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsa-kind",
						children: step.kind
					}),
					step.file !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dsa-code-ref",
						children: [
							step.file,
							step.line !== void 0 ? `:${step.line}` : "",
							step.scope !== void 0 ? ` ${step.scope}()` : ""
						]
					}),
					step.description !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsa-text",
						children: step.description
					})
				] }, i))
			});
		}
		function FindingCard(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const { finding } = props;
			if (!isConfirmed(finding)) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsa-card dsa-rejected",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsa-card-head",
					onClick: () => setOpen((o) => !o),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsa-badges",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
							color: "#8d8d8d",
							label: "rejected"
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsa-card-title",
						children: finding.title ?? `Rejected candidate #${props.index + 1}`
					})]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsa-card-body",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsa-text",
						children: finding.reason ?? "(no reason recorded)"
					})
				})]
			});
			const severity = asSeverity(finding.severity?.overall_severity);
			const color = SEVERITY_COLORS[severity];
			const trace = finding.trace ?? [];
			const conditions = finding.conditions ?? [];
			const execution = finding.execution;
			const remediation = finding.remediation;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsa-card",
				style: { borderLeftColor: color },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsa-card-head",
					onClick: () => setOpen((o) => !o),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsa-badges",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								color,
								label: SEVERITY_LABELS[severity]
							}), finding.confidence?.score !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsa-badge ghost",
								children: [String(finding.confidence.score), " conf."]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsa-card-title",
							children: finding.title ?? "(untitled finding)"
						}),
						finding.root_cause !== void 0 && !open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsa-hint",
							style: { marginTop: 4 },
							children: finding.root_cause
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsa-card-body",
					children: [
						finding.description !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: "Description",
							defaultOpen: true,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-text",
								children: finding.description
							})
						}),
						finding.root_cause !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: "Root cause",
							defaultOpen: true,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-text",
								children: finding.root_cause
							})
						}),
						finding.intended_behavior !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: "Intended behavior",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-text",
								children: finding.intended_behavior
							})
						}),
						trace.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: `Trace (${trace.length} steps)`,
							defaultOpen: true,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TraceList, { steps: trace })
						}),
						conditions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
							title: `Exploitation conditions (${conditions.length})`,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: "dsa-text",
								style: {
									margin: "4px 0 4px 18px",
									padding: 0
								},
								children: conditions.map((c, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsa-kind",
									children: c.kind ?? "condition"
								}), c.description] }, i))
							})
						}),
						execution !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: "Execution",
							children: [
								execution.attacker_perspective !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsa-text",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Attacker:" }),
										" ",
										execution.attacker_perspective
									]
								}),
								(execution.payloads ?? []).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: { marginTop: 6 },
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Payloads" })
								}), (execution.payloads ?? []).map((p, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									className: "dsa-pre",
									children: p
								}, i))] }),
								(execution.instructions ?? []).length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: { marginTop: 6 },
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Instructions" })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
									style: {
										margin: "4px 0 4px 18px",
										padding: 0
									},
									children: (execution.instructions ?? []).map((s, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
										className: "dsa-text",
										children: s
									}, i))
								})] }),
								execution.expected_result !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsa-text",
									style: { marginTop: 4 },
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Expected result:" }),
										" ",
										execution.expected_result
									]
								})
							]
						}),
						remediation !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: "Remediation",
							children: [remediation.strategy !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-text",
								children: remediation.strategy
							}), (remediation.code_changes ?? []).map((c, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [c.file_name !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-code-ref",
								children: c.file_name
							}), c.fixed_code !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								className: "dsa-pre",
								children: c.fixed_code
							})] }, i))]
						}),
						finding.severity?.likelihood?.reason !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: "Severity rationale",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsa-text",
								children: [
									"Likelihood (",
									String(finding.severity.likelihood.score ?? "-"),
									"): ",
									finding.severity.likelihood.reason
								]
							}), finding.severity.impact?.reason !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsa-text",
								children: [
									"Impact (",
									String(finding.severity.impact.score ?? "-"),
									"): ",
									finding.severity.impact.reason
								]
							})]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Panel styles: one <style> tag injected once. Colors are theme-neutral
		* (translucent grays + fixed severity colors) so the panel reads on both
		* light and dark shells.
		*/
		const STYLE_TAG_ID = "dsh-sidebar-security-audit-styles";
		const PANEL_CSS = `.dsa-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12.5px; line-height: 1.5; }
.dsa-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 24px; }
.dsa-header { padding: 10px 12px 8px; border-bottom: 1px solid rgba(128,128,128,0.22); }
.dsa-root-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.dsa-root-input { flex: 1; min-width: 0; background: rgba(128,128,128,0.10); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 4px 8px; font-size: 11.5px; font-family: ui-monospace, monospace; }
.dsa-btn { background: rgba(128,128,128,0.14); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; white-space: nowrap; }
.dsa-btn:hover { background: rgba(128,128,128,0.24); }
.dsa-btn.active { background: rgba(77,107,254,0.25); border-color: rgba(77,107,254,0.6); }
.dsa-hint { color: rgba(128,128,128,0.95); font-size: 11px; margin-top: 4px; }
.dsa-error { margin: 8px 12px; padding: 8px 10px; border-radius: 8px; background: rgba(229,72,77,0.12); border: 1px solid rgba(229,72,77,0.45); }
.dsa-select { width: 100%; background: rgba(128,128,128,0.10); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 5px 8px; font-size: 12px; }
.dsa-stats { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 6px; }
.dsa-stat { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(128,128,128,0.28); background: rgba(128,128,128,0.08); font-size: 11.5px; cursor: pointer; user-select: none; }
.dsa-stat.static { cursor: default; }
.dsa-stat.on { border-color: currentColor; background: rgba(128,128,128,0.20); }
.dsa-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dsa-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.dsa-search { flex: 1; min-width: 120px; background: rgba(128,128,128,0.10); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 4px 8px; font-size: 11.5px; }
.dsa-files { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.dsa-card { border: 1px solid rgba(128,128,128,0.26); border-left-width: 3px; border-radius: 8px; margin-bottom: 8px; background: rgba(128,128,128,0.05); overflow: hidden; }
.dsa-card-head { padding: 8px 10px; cursor: pointer; }
.dsa-card-title { font-weight: 600; margin: 4px 0 0; }
.dsa-badges { display: inline-flex; gap: 5px; align-items: center; vertical-align: middle; }
.dsa-badge { font-size: 10px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; border-radius: 4px; padding: 1px 6px; color: #fff; }
.dsa-badge.ghost { color: inherit; border: 1px solid rgba(128,128,128,0.4); background: transparent; font-weight: 600; }
.dsa-card-body { padding: 2px 10px 10px; border-top: 1px dashed rgba(128,128,128,0.25); }
.dsa-sec { margin-top: 8px; }
.dsa-sec > summary { cursor: pointer; font-weight: 600; font-size: 11.5px; opacity: 0.9; }
.dsa-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; }
.dsa-pre { white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(128,128,128,0.12); border-radius: 6px; padding: 6px 8px; margin: 4px 0; font-family: ui-monospace, monospace; font-size: 11px; }
.dsa-trace { list-style: none; margin: 4px 0; padding: 0; }
.dsa-trace li { margin: 4px 0; padding-left: 8px; border-left: 2px solid rgba(128,128,128,0.35); }
.dsa-code-ref { font-family: ui-monospace, monospace; font-size: 11px; background: rgba(128,128,128,0.14); border-radius: 4px; padding: 0 4px; }
.dsa-kind { font-size: 10px; font-weight: 700; text-transform: uppercase; border-radius: 4px; padding: 0 5px; margin-right: 4px; border: 1px solid rgba(128,128,128,0.4); }
.dsa-empty { padding: 28px 16px; text-align: center; opacity: 0.8; }
.dsa-rejected { border-left-color: #8d8d8d !important; opacity: 0.85; }
`;
		/** Inject the panel stylesheet once per document. */
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-sidebar-security-audit-styles") !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_TAG_ID;
			tag.textContent = PANEL_CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/AuditPanel.tsx
		/**
		* The Security Audit sidebar tab: discovers audit runs (host route), selects
		* one, parses its findings.json and renders severity stats, filters, finding
		* cards, and one-click opening of the run's markdown artifacts through the
		* better-sidebar file viewer.
		*/
		/** localStorage key for the root override. */
		const ROOT_KEY = "dsh-sidebar-security-audit:root";
		/** Artifacts openable in the sidebar viewer (host-whitelisted). */
		const ARTIFACTS = [
			"REPORT.md",
			"FINDINGS-DETAIL.md",
			"architecture.md"
		];
		function loadStoredRoot() {
			try {
				return window.localStorage.getItem(ROOT_KEY) ?? "";
			} catch {
				return "";
			}
		}
		function storeRoot(root) {
			try {
				if (root === "") window.localStorage.removeItem(ROOT_KEY);
				else window.localStorage.setItem(ROOT_KEY, root);
			} catch {}
		}
		function formatTime(ms) {
			if (ms <= 0) return "unknown";
			try {
				return new Date(ms).toLocaleString();
			} catch {
				return "unknown";
			}
		}
		function AuditPanel(props) {
			const { scope, service, visible } = props;
			const [rootDraft, setRootDraft] = (0, react.useState)(loadStoredRoot);
			const [root, setRoot] = (0, react.useState)(loadStoredRoot);
			const [serverRoot, setServerRoot] = (0, react.useState)("");
			const [runs, setRuns] = (0, react.useState)([]);
			const [selectedDir, setSelectedDir] = (0, react.useState)("");
			const [findings, setFindings] = (0, react.useState)([]);
			const [parseError, setParseError] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)("");
			const [loadingRuns, setLoadingRuns] = (0, react.useState)(false);
			const [loadingFindings, setLoadingFindings] = (0, react.useState)(false);
			const [sevFilter, setSevFilter] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [verdict, setVerdict] = (0, react.useState)("all");
			const [query, setQuery] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				injectStyles();
			}, []);
			const refresh = (0, react.useCallback)(async (rootOverride) => {
				setLoadingRuns(true);
				setError("");
				try {
					const resp = await api.runs(rootOverride !== void 0 && rootOverride !== "" ? rootOverride : void 0);
					setRuns(resp.runs);
					setServerRoot(resp.root);
					setSelectedDir((prev) => resp.runs.some((r) => r.dir === prev) ? prev : resp.runs[0]?.dir ?? "");
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
					setRuns([]);
					setSelectedDir("");
				} finally {
					setLoadingRuns(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh(root !== "" ? root : void 0);
			}, [refresh, root]);
			(0, react.useEffect)(() => {
				if (visible) refresh(root !== "" ? root : void 0);
			}, [visible]);
			const selected = (0, react.useMemo)(() => runs.find((r) => r.dir === selectedDir), [runs, selectedDir]);
			(0, react.useEffect)(() => {
				let cancelled = false;
				if (selectedDir === "" || serverRoot === "") {
					setFindings([]);
					setParseError("");
					return;
				}
				setLoadingFindings(true);
				api.findings(selectedDir, serverRoot).then((resp) => {
					if (cancelled) return;
					const parsed = parseFindings(resp.content);
					setFindings(parsed.findings);
					setParseError(parsed.parseError ?? (resp.truncated ? "findings.json truncated (too large)" : ""));
				}).catch((e) => {
					if (cancelled) return;
					setFindings([]);
					setParseError(e instanceof Error ? e.message : String(e));
				}).finally(() => {
					if (!cancelled) setLoadingFindings(false);
				});
				return () => {
					cancelled = true;
				};
			}, [selectedDir, serverRoot]);
			const clientCounts = (0, react.useMemo)(() => {
				const counts = {
					total: findings.length,
					confirmed: 0,
					rejected: 0
				};
				for (const f of findings) if (isConfirmed(f)) counts.confirmed += 1;
				else counts.rejected += 1;
				return counts;
			}, [findings]);
			const sevCounts = (0, react.useMemo)(() => {
				const map = {};
				for (const f of findings) {
					if (!isConfirmed(f)) continue;
					const sev = asSeverity(f.severity?.overall_severity);
					map[sev] = (map[sev] ?? 0) + 1;
				}
				return map;
			}, [findings]);
			const filtered = (0, react.useMemo)(() => {
				const q = query.trim().toLowerCase();
				const rankOf = (f) => isConfirmed(f) ? SEVERITY_ORDER.indexOf(asSeverity(f.severity?.overall_severity)) : SEVERITY_ORDER.length;
				return findings.filter((f) => {
					if (verdict === "confirmed" && !isConfirmed(f)) return false;
					if (verdict === "rejected" && isConfirmed(f)) return false;
					if (isConfirmed(f) && sevFilter.size > 0 && !sevFilter.has(asSeverity(f.severity?.overall_severity))) return false;
					if (q !== "") {
						if (!(isConfirmed(f) ? `${f.title ?? ""} ${f.description ?? ""} ${f.root_cause ?? ""}` : `${f.title ?? ""} ${f.reason ?? ""}`).toLowerCase().includes(q)) return false;
					}
					return true;
				}).sort((a, b) => rankOf(a) - rankOf(b));
			}, [
				findings,
				verdict,
				sevFilter,
				query
			]);
			const toggleSev = (sev) => {
				setSevFilter((prev) => {
					const next = new Set(prev);
					if (next.has(sev)) next.delete(sev);
					else next.add(sev);
					return next;
				});
			};
			const applyRoot = () => {
				const next = rootDraft.trim();
				storeRoot(next);
				setRoot(next);
			};
			const openArtifact = (file) => {
				if (selected === void 0) return;
				const path = `${selected.dir}/${file}`;
				service.openFile(scope, path, `${selected.repo !== "." ? selected.repo + "/" : ""}${selected.name} · ${file}`);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsa-panel",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsa-header",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Security Audit" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "dsa-btn",
										onClick: () => void refresh(root !== "" ? root : void 0),
										disabled: loadingRuns,
										children: loadingRuns ? "Scanning…" : "Refresh"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsa-root-row",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: "dsa-root-input",
										value: rootDraft,
										placeholder: serverRoot !== "" ? serverRoot : "~/security-audit-skill",
										onChange: (e) => setRootDraft(e.target.value),
										onKeyDown: (e) => {
											if (e.key === "Enter") applyRoot();
										},
										spellCheck: false,
										title: "Audit root directory (absolute, ~/…, or relative to the workspace)"
									}),
									root !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "dsa-btn",
										onClick: () => {
											setRootDraft("");
											storeRoot("");
											setRoot("");
										},
										title: "Back to server default",
										children: "Default"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "dsa-btn",
										onClick: applyRoot,
										children: "Go"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsa-hint",
								children: [
									"Scans ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: serverRoot !== "" ? serverRoot : "…" }),
									" — prefers the workspace's .security-audit folder, else the skill's default output root."
								]
							})
						]
					}),
					error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsa-error",
						children: ["Scan failed: ", error]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsa-scroll",
						children: [runs.length === 0 && !loadingRuns && error === "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsa-empty",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 22,
										marginBottom: 6
									},
									children: "🛡️"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: "No audit runs found yet." }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsa-hint",
									style: { marginTop: 8 },
									children: [
										"Ask the agent to run the ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "security-audit" }),
										" skill on a repo; each run writes findings.json / REPORT.md under ",
										"<root>/<repo>/run-<N>",
										"."
									]
								})
							]
						}), runs.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								className: "dsa-select",
								value: selectedDir,
								onChange: (e) => setSelectedDir(e.target.value),
								children: runs.map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: r.dir,
									children: [
										r.repo !== "." ? `${r.repo} / ` : "",
										r.name,
										r.counts !== void 0 ? ` — ${r.counts.confirmed} confirmed / ${r.counts.rejected} rejected` : ""
									]
								}, r.dir))
							}),
							selected !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsa-hint",
									style: { marginTop: 6 },
									children: [
										selected.dir,
										" · updated ",
										formatTime(selected.updatedAt)
									]
								}),
								selected.parseError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsa-error",
									style: { margin: "6px 0" },
									children: selected.parseError
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsa-files",
									children: ARTIFACTS.filter((f) => selected.files[f] === true).map((f) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										className: "dsa-btn",
										onClick: () => openArtifact(f),
										title: "Open in sidebar viewer",
										children: ["📄 ", f]
									}, f))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsa-stats",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsa-stat static",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: clientCounts.confirmed }), "\xA0confirmed"]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsa-stat static",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: clientCounts.rejected }), "\xA0rejected"]
										}),
										SEVERITY_ORDER.map((sev) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: `dsa-stat${sevFilter.has(sev) ? " on" : ""}`,
											style: { color: SEVERITY_COLORS[sev] },
											onClick: () => toggleSev(sev),
											title: "Filter by severity",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsa-dot",
													style: { background: SEVERITY_COLORS[sev] }
												}),
												SEVERITY_LABELS[sev],
												" ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: sevCounts[sev] ?? 0 })
											]
										}, sev))
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsa-filters",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: `dsa-btn${verdict === "all" ? " active" : ""}`,
											onClick: () => setVerdict("all"),
											children: "All"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: `dsa-btn${verdict === "confirmed" ? " active" : ""}`,
											onClick: () => setVerdict("confirmed"),
											children: "Confirmed"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											className: `dsa-btn${verdict === "rejected" ? " active" : ""}`,
											onClick: () => setVerdict("rejected"),
											children: "Rejected"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: "dsa-search",
											placeholder: "Search findings…",
											value: query,
											onChange: (e) => setQuery(e.target.value)
										})
									]
								})
							] }),
							loadingFindings && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-hint",
								children: "Loading findings.json…"
							}),
							!loadingFindings && parseError !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsa-error",
								children: ["findings.json: ", parseError]
							}),
							!loadingFindings && findings.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [filtered.map((f, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FindingCard, {
								finding: f,
								index: i
							}, i)), filtered.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-empty",
								children: "No findings match the current filters."
							})] }),
							!loadingFindings && findings.length === 0 && parseError === "" && selected !== void 0 && selected.files["findings.json"] !== true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsa-hint",
								children: "This run has no findings.json yet (structured output is Phase 5 of the skill)."
							})
						] })]
					})
				]
			});
		}
		//#endregion
		//#region src/client/icons.tsx
		/**
		* Tab / UI icons: inline SVGs sized by the sidebar (no icon dependency).
		*/
		function ShieldIcon(props) {
			const size = props.size ?? 16;
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: "M12 3l7 3v5c0 4.5-2.9 8.4-7 10-4.1-1.6-7-5.5-7-10V6l7-3z" }), (0, react.createElement)("path", { d: "M9.2 12.2l1.9 1.9 3.7-4" }));
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* Client half of dsh-sidebar-security-audit: registers the "Security Audit"
		* sidebar tab through the dsh-better-sidebar service. The tab component is
		* the panel; data comes from this plugin's own fenced host routes.
		* @module dsh-sidebar-security-audit/client
		*/
		/** Services required before mounting. */
		const inject = ["betterSidebar"];
		/** Plugin body. */
		function apply(ctx) {
			ctx.effect(() => ctx.betterSidebar.registerTab({
				id: "security-audit:panel",
				title: () => "Security Audit",
				icon: (size) => (0, react.createElement)(ShieldIcon, { size }),
				order: 45,
				single: true,
				component: (props) => (0, react.createElement)(AuditPanel, {
					...props,
					service: ctx.betterSidebar
				})
			}), "dsh-sidebar-security-audit: tab");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map