const { useCallback, useEffect, useMemo, useState } = React;
const h = (type, props, ...children) =>
  React.createElement(type, props || {}, ...children.flat());

const EMPTY_QUESTION = {
  id: "",
  language: "english",
  level: "A1",
  type: "multiple_choice",
  status: "published",
  text: "",
  options: ["", ""],
  correctAnswers: [],
  explanation: "",
};

const LANGUAGES = [
  ["english", "English"],
  ["german", "German"],
  ["french", "French"],
];
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const TYPES = [
  ["multiple_choice", "Multiple choice"],
  ["gap_fill", "Gap fill"],
];
const STAT_LABELS = {
  activeUsers: "Active users",
  totalUsers: "Total users",
  totalQuestions: "Questions",
  publishedQuestions: "Published",
  draftQuestions: "Drafts",
  activeRooms: "Active rooms",
  playerReports: "Player reports",
  questionReports: "Question reports",
};

function App() {
  const [token, setToken] = useState(localStorage.getItem("admin_token") || "");
  const [admin, setAdmin] = useState(null);
  const [activeView, setActiveView] = useState("overview");
  const [loading, setLoading] = useState(Boolean(token));
  const [message, setMessage] = useState("");
  const [pendingQuestionEdit, setPendingQuestionEdit] = useState(null);
  const clearPendingQuestionEdit = useCallback(() => setPendingQuestionEdit(null), []);

  const api = useCallback(
    async (path, options = {}) => {
      const response = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    },
    [token]
  );

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const data = await api("/admin/api/me");
        if (!cancelled) setAdmin(data.user);
      } catch (err) {
        localStorage.removeItem("admin_token");
        if (!cancelled) {
          setToken("");
          setAdmin(null);
          setMessage(err.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    restore();
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  function handleLogin(data) {
    localStorage.setItem("admin_token", data.token);
    setToken(data.token);
    setAdmin(data.user);
    setMessage("");
    setActiveView("overview");
  }

  function logout() {
    localStorage.removeItem("admin_token");
    setToken("");
    setAdmin(null);
    setMessage("");
  }

  if (loading) {
    return h("main", { className: "loading-screen" }, "Loading admin dashboard...");
  }

  if (!admin || !token) {
    return h(LoginView, { onLogin: handleLogin, message });
  }

  return h(
    "main",
    { className: "shell" },
    h(Sidebar, { admin, activeView, setActiveView, logout }),
    h(
      "section",
      { className: "content" },
      activeView === "overview" && h(OverviewView, { api, setActiveView }),
      activeView === "questions" && h(QuestionsView, {
        api,
        pendingQuestionEdit,
        clearPendingQuestionEdit,
      }),
      activeView === "playerReports" && h(PlayerReportsView, { api }),
      activeView === "questionReports" && h(QuestionReportsView, {
        api,
        setActiveView,
        setPendingQuestionEdit,
      }),
      activeView === "users" && h(UsersView, { api })
    )
  );
}

function LoginView({ onLogin, message }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(message || "");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/admin/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not sign in");
      onLogin(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return h(
    "main",
    { className: "login-page" },
    h(
      "form",
      { className: "login-box", onSubmit: submit },
      h("p", { className: "eyebrow" }, "LangBattle Admin"),
      h("h1", null, "Admin Login"),
      h(
        "label",
        null,
        "Email",
        h("input", {
          type: "email",
          value: email,
          autoComplete: "email",
          required: true,
          onChange: (event) => setEmail(event.target.value),
        })
      ),
      h(
        "label",
        null,
        "Password",
        h("input", {
          type: "password",
          value: password,
          autoComplete: "current-password",
          required: true,
          onChange: (event) => setPassword(event.target.value),
        })
      ),
      h(
        "button",
        { className: "primary-button", type: "submit", disabled: submitting },
        submitting ? "Signing in..." : "Sign in"
      ),
      h("p", { className: "message danger" }, error)
    )
  );
}

function Sidebar({ admin, activeView, setActiveView, logout }) {
  const items = [
    ["overview", "Overview", "Dashboard"],
    ["questions", "Questions", "Question bank"],
    ["playerReports", "Players", "Reported players"],
    ["questionReports", "Reports", "Reported questions"],
    ["users", "Users", "Accounts"],
  ];

  return h(
    "aside",
    { className: "sidebar" },
    h(
      "div",
      null,
      h("div", { className: "brand" }, "LangBattle Admin"),
      h("div", { className: "admin-user" }, admin.email || admin.name),
      h(
        "nav",
        { className: "nav" },
        items.map(([view, label, hint]) =>
          h(
            "button",
            {
              key: view,
              type: "button",
              className: `nav-button ${activeView === view ? "active" : ""}`,
              onClick: () => setActiveView(view),
              title: hint,
            },
            h("span", { className: "nav-icon" }, label.slice(0, 1)),
            h("span", null, label)
          )
        )
      )
    ),
    h("button", { className: "ghost-button", type: "button", onClick: logout }, "Log out")
  );
}

function OverviewView({ api, setActiveView }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await api("/admin/api/dashboard"));
    } catch (err) {
      setError(err.message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = data?.stats || {};
  const statKeys = [
    "activeUsers",
    "totalUsers",
    "totalQuestions",
    "publishedQuestions",
    "draftQuestions",
    "activeRooms",
    "playerReports",
    "questionReports",
  ];

  return h(
    "section",
    { className: "view active" },
    h(
      Header,
      {
        title: "Dashboard",
        subtitle: "Live admin view for users, questions, and moderation signals.",
      },
      h("button", { className: "secondary-button", type: "button", onClick: load }, "Refresh")
    ),
    h(
      "section",
      { className: "stats-grid" },
      statKeys.map((key) =>
        h(
          "article",
          { className: "stat-card", key },
          h("span", null, STAT_LABELS[key]),
          h("strong", null, number(stats[key]))
        )
      )
    ),
    h(
      "div",
      { className: "report-grid" },
      h(CompactReportPanel, {
        title: "Most reported players",
        empty: "No player reports yet.",
        action: "Open players",
        onAction: () => setActiveView("playerReports"),
        rows: data?.reportedPlayers || [],
        renderRow: (row) =>
          h(
            "div",
            { className: "compact-row", key: row.userId },
            h(
              "div",
              null,
              h("strong", null, row.user?.name || "Unknown player"),
              h("span", null, row.user?.email || row.userId)
            ),
            h("span", { className: "count-pill" }, number(row.reportCount))
          ),
      }),
      h(CompactReportPanel, {
        title: "Most reported questions",
        empty: "No question reports yet.",
        action: "Open questions",
        onAction: () => setActiveView("questionReports"),
        rows: data?.reportedQuestions || [],
        renderRow: (row) =>
          h(
            "div",
            { className: "compact-row", key: row.questionId },
            h(
              "div",
              null,
              h("strong", null, row.question?.text || row.questionId),
              h("span", null, row.question?.language || "Unknown language")
            ),
            h("span", { className: "count-pill" }, number(row.reportCount))
          ),
      })
    ),
    h("p", { className: "message danger" }, error)
  );
}

function CompactReportPanel({ title, rows, empty, action, onAction, renderRow }) {
  return h(
    "section",
    { className: "panel compact-panel" },
    h(
      "div",
      { className: "panel-header" },
      h("h2", null, title),
      h("button", { className: "ghost-button small-button", type: "button", onClick: onAction }, action)
    ),
    rows.length ? rows.map(renderRow) : h("p", { className: "empty" }, empty)
  );
}

function QuestionsView({ api, pendingQuestionEdit, clearPendingQuestionEdit }) {
  const [questions, setQuestions] = useState([]);
  const [selected, setSelected] = useState(EMPTY_QUESTION);
  const [filters, setFilters] = useState(() => ({
    q: pendingQuestionEdit?.id || sessionStorage.getItem("admin_question_focus") || "",
    language: "",
    level: "",
    type: "",
    status: "",
    missingExplanation: false,
  }));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [draftCount, setDraftCount] = useState(1);

  useEffect(() => {
    if (!pendingQuestionEdit?.id) return;
    setFilters((current) => ({ ...current, q: pendingQuestionEdit.id }));
    if (pendingQuestionEdit.snapshot) {
      selectQuestion(pendingQuestionEdit.snapshot);
      setMessage("Loaded reported question details. Add options/correct answer, then save it to the question bank.");
    }
  }, [pendingQuestionEdit]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (key === "missingExplanation") {
        if (value) params.set(key, "true");
      } else if (value) {
        params.set(key, value);
      }
    });
    return params.toString();
  }, [filters]);

  const load = useCallback(async () => {
    try {
      const data = await api(`/admin/api/questions${query ? `?${query}` : ""}`);
      const loadedQuestions = data.questions || [];
      setQuestions(loadedQuestions);

      const focusId = pendingQuestionEdit?.id || sessionStorage.getItem("admin_question_focus");
      if (focusId) {
        const match = loadedQuestions.find((question) => question.id === focusId);
        const snapshot = pendingQuestionEdit?.snapshot || readPendingQuestionSnapshot(focusId);
        if (match) {
          selectQuestion(match);
          clearPendingQuestionEdit?.();
          clearPendingQuestionFocus();
        } else if (snapshot) {
          selectQuestion(snapshot);
          setMessage("Loaded reported question details. Add options/correct answer, then save it to the question bank.");
          clearPendingQuestionEdit?.();
          clearPendingQuestionFocus();
        } else {
          setMessage("That reported question was not found in the question bank.");
          clearPendingQuestionEdit?.();
          clearPendingQuestionFocus();
        }
      }
    } catch (err) {
      setMessage(err.message);
    }
  }, [api, query, pendingQuestionEdit, clearPendingQuestionEdit]);

  useEffect(() => {
    load();
  }, [load]);

  function selectQuestion(question) {
    setSelected({
      ...EMPTY_QUESTION,
      ...question,
      options: question.options || [],
      correctAnswers: question.correctAnswers || [],
    });
    setMessage("");
  }

  function updateSelected(key, value) {
    setSelected((current) => ({ ...current, [key]: value }));
  }

  function resetQuestion() {
    setDraftCount((count) => count + 1);
    setSelected({ ...EMPTY_QUESTION, options: [...EMPTY_QUESTION.options] });
    setMessage("Ready to add a new question.");
    window.setTimeout(() => {
      document.querySelector(".editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("editText")?.focus();
    }, 0);
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const body = {
        ...selected,
        options: normalizeOptions(selected.options),
        correctAnswers: asLines(selected.correctAnswers),
      };
      const data = await api("/admin/api/questions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      selectQuestion(data.question);
      setMessage("Question saved.");
      await load();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected.id) return;
    if (!confirm(`Delete ${selected.id}?`)) return;
    try {
      await api(`/admin/api/questions/${encodeURIComponent(selected.id)}`, {
        method: "DELETE",
      });
      resetQuestion();
      setMessage("Question deleted.");
      await load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  return h(
    "section",
    { className: "view active" },
    h(
      Header,
      {
        title: "Questions",
        subtitle: "Create, edit, publish, and delete battle questions.",
      },
      h(
        "button",
        {
          className: "primary-button",
          type: "button",
          onClick: resetQuestion,
        },
        "New question"
      )
    ),
    h(FilterBar, { filters, setFilters }),
    h(
      "div",
      { className: "split" },
      h(
        "section",
        { className: "table-panel" },
        h(
          "table",
          null,
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              ["ID", "Question", "Language", "Level", "Type", "Status"].map((label) =>
                h("th", { key: label }, label)
              )
            )
          ),
          h(
            "tbody",
            null,
            questions.map((question) =>
              h(
                "tr",
                {
                  key: question.id,
                  className: selected.id === question.id ? "selected" : "",
                  onClick: () => selectQuestion(question),
                },
                h("td", null, question.id),
                h("td", null, question.text),
                h("td", null, question.language),
                h("td", null, question.level),
                h("td", null, humanType(question.type)),
                h("td", null, h("span", { className: "pill" }, question.status || "published"))
              )
            )
          )
        )
      ),
      h(
        "form",
        { className: "editor", onSubmit: save, "data-draft": draftCount },
        h("h2", null, selected.id ? "Edit question" : "New question"),
        h(TextField, {
          label: "ID",
          value: selected.id,
          placeholder: "admin_english_a1_001",
          onChange: (value) => updateSelected("id", value),
        }),
        h(
          "div",
          { className: "grid-2" },
          h(SelectField, {
            label: "Language",
            value: selected.language,
            options: LANGUAGES,
            onChange: (value) => updateSelected("language", value),
          }),
          h(SelectField, {
            label: "Level",
            value: selected.level,
            options: LEVELS.map((level) => [level, level]),
            onChange: (value) => updateSelected("level", value),
          })
        ),
        h(
          "div",
          { className: "grid-2" },
          h(SelectField, {
            label: "Type",
            value: selected.type,
            options: TYPES,
            onChange: (value) => updateSelected("type", value),
          }),
          h(SelectField, {
            label: "Status",
            value: selected.status,
            options: [
              ["published", "Published"],
              ["draft", "Draft"],
            ],
            onChange: (value) => updateSelected("status", value),
          })
        ),
        h(TextAreaField, {
          label: "Question text",
          id: "editText",
          value: selected.text,
          rows: 3,
          placeholder: "Use ___ for gap fill questions",
          onChange: (value) => updateSelected("text", value),
        }),
        h(OptionEditor, {
          options: selected.options,
          correctAnswers: selected.correctAnswers,
          onOptionsChange: (value) => updateSelected("options", value),
          onCorrectAnswersChange: (value) => updateSelected("correctAnswers", value),
        }),
        h(TextAreaField, {
          label: "Explanation",
          value: selected.explanation,
          rows: 4,
          placeholder: "Explain why the correct answer fits.",
          onChange: (value) => updateSelected("explanation", value),
        }),
        h(
          "div",
          { className: "editor-actions" },
          h("button", { className: "primary-button", type: "submit", disabled: saving }, saving ? "Saving..." : "Save"),
          h("button", { className: "ghost-button", type: "button", onClick: remove, disabled: !selected.id }, "Delete")
        ),
        h("p", { className: message === "Question saved." || message === "Question deleted." ? "message success" : "message danger" }, message)
      )
    )
  );
}

function OptionEditor({ options, correctAnswers, onOptionsChange, onCorrectAnswersChange }) {
  const rows = normalizeOptionRows(options);
  const answers = asLines(correctAnswers);

  function changeOption(index, value) {
    const oldValue = rows[index]?.trim();
    const nextRows = rows.map((option, optionIndex) =>
      optionIndex === index ? value : option
    );
    const nextAnswers = answers.map((answer) =>
      oldValue && answer === oldValue ? value.trim() : answer
    ).filter(Boolean);
    onOptionsChange(nextRows);
    onCorrectAnswersChange(unique(nextAnswers));
  }

  function toggleCorrect(value) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const nextAnswers = answers.includes(trimmed)
      ? answers.filter((answer) => answer !== trimmed)
      : [...answers, trimmed];
    onCorrectAnswersChange(unique(nextAnswers));
  }

  function addOption() {
    onOptionsChange([...rows, ""]);
  }

  function removeOption(index) {
    const removed = rows[index]?.trim();
    const nextRows = rows.filter((_, optionIndex) => optionIndex !== index);
    onOptionsChange(nextRows.length >= 2 ? nextRows : [...nextRows, ""]);
    onCorrectAnswersChange(answers.filter((answer) => answer !== removed));
  }

  return h(
    "section",
    { className: "option-editor" },
    h("div", { className: "option-editor-header" },
      h("span", null, "Options"),
      h("span", null, "Correct")
    ),
    rows.map((option, index) =>
      h(
        "div",
        { className: "option-row", key: index },
        h("input", {
          value: option,
          placeholder: `Option ${index + 1}`,
          onChange: (event) => changeOption(index, event.target.value),
        }),
        h("input", {
          className: "correct-checkbox",
          type: "checkbox",
          checked: answers.includes(option.trim()) && option.trim().length > 0,
          disabled: option.trim().length === 0,
          onChange: () => toggleCorrect(option),
          title: "Correct answer",
        }),
        h(
          "button",
          {
            className: "ghost-button icon-button",
            type: "button",
            disabled: rows.length <= 2,
            onClick: () => removeOption(index),
            title: "Remove option",
          },
          "-"
        )
      )
    ),
    h("button", { className: "secondary-button", type: "button", onClick: addOption }, "Add option")
  );
}

function FilterBar({ filters, setFilters }) {
  function update(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return h(
    "div",
    { className: "toolbar" },
    h("input", {
      value: filters.q,
      placeholder: "Search id or question text",
      onChange: (event) => update("q", event.target.value),
    }),
    h(InlineSelect, {
      value: filters.language,
      options: [["", "All languages"], ...LANGUAGES],
      onChange: (value) => update("language", value),
    }),
    h(InlineSelect, {
      value: filters.level,
      options: [["", "All levels"], ...LEVELS.map((level) => [level, level])],
      onChange: (value) => update("level", value),
    }),
    h(InlineSelect, {
      value: filters.type,
      options: [["", "All types"], ...TYPES],
      onChange: (value) => update("type", value),
    }),
    h(InlineSelect, {
      value: filters.status,
      options: [
        ["", "All statuses"],
        ["published", "Published"],
        ["draft", "Draft"],
      ],
      onChange: (value) => update("status", value),
    }),
    h(
      "label",
      { className: "check-label" },
      h("input", {
        type: "checkbox",
        checked: filters.missingExplanation,
        onChange: (event) => update("missingExplanation", event.target.checked),
      }),
      "Missing explanation"
    )
  );
}

function PlayerReportsView({ api }) {
  const [reports, setReports] = useState([]);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api("/admin/api/reports/players");
      setReports(data.reports || []);
    } catch (err) {
      setMessage(err.message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function ban(row) {
    const reason = prompt(`Ban ${row.user?.name || row.userId}? Reason:`, row.latestReason || "Account suspended");
    if (reason === null) return;
    try {
      await api(`/admin/api/users/${encodeURIComponent(row.userId)}/ban`, {
        method: "PATCH",
        body: JSON.stringify({ reason }),
      });
      setMessage("User banned.");
      await load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function unban(row) {
    if (!confirm(`Unban ${row.user?.name || row.userId}?`)) return;
    try {
      await api(`/admin/api/users/${encodeURIComponent(row.userId)}/unban`, {
        method: "PATCH",
      });
      setMessage("User unbanned.");
      await load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  return h(
    "section",
    { className: "view active" },
    h(
      Header,
      {
        title: "Reported Players",
        subtitle: "Players grouped by report count, newest report shown for context.",
      },
      h("button", { className: "secondary-button", type: "button", onClick: load }, "Refresh")
    ),
    h(
      "section",
      { className: "table-panel" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["Player", "Email", "Reports", "Latest reason", "Latest report", "Status", "Action"].map((label) =>
              h("th", { key: label }, label)
            )
          )
        ),
        h(
          "tbody",
          null,
          reports.map((row) =>
            h(
              "tr",
              { key: row.userId },
              h("td", null, row.user?.name || "Unknown player"),
              h("td", null, row.user?.email || row.userId),
              h("td", null, h("span", { className: "count-pill" }, number(row.reportCount))),
              h("td", null, row.latestReason || "No reason"),
              h("td", null, date(row.latestReportedAt)),
              h("td", null, row.user?.banned ? h("span", { className: "pill danger" }, row.user.banReason || "Banned") : h("span", { className: "pill" }, "Active")),
              h(
                "td",
                null,
                h(
                  "button",
                  {
                    className: row.user?.banned ? "secondary-button small-button" : "ghost-button small-button",
                    type: "button",
                    onClick: () => (row.user?.banned ? unban(row) : ban(row)),
                  },
                  row.user?.banned ? "Unban" : "Ban"
                )
              )
            )
          )
        )
      ),
      reports.length === 0 && h("p", { className: "empty table-empty" }, "No reported players yet.")
    ),
    h("p", { className: message.includes("banned") ? "message success" : "message danger" }, message)
  );
}

function QuestionReportsView({ api, setActiveView, setPendingQuestionEdit }) {
  const [reports, setReports] = useState([]);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api("/admin/api/reports/questions");
      setReports(data.reports || []);
    } catch (err) {
      setMessage(err.message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(row) {
    if (!row.questionId) return;
    if (!confirm(`Delete question ${row.questionId}?`)) return;
    try {
      await api(`/admin/api/questions/${encodeURIComponent(row.questionId)}`, {
        method: "DELETE",
      });
      setMessage("Question deleted.");
      await load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  return h(
    "section",
    { className: "view active" },
    h(
      Header,
      {
        title: "Reported Questions",
        subtitle: "Question report totals with latest moderation context.",
      },
      h("button", { className: "secondary-button", type: "button", onClick: load }, "Refresh")
    ),
    h(
      "section",
      { className: "table-panel" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["Question", "Language", "Level", "Reports", "Latest reason", "Latest report", "Action"].map((label) =>
              h("th", { key: label }, label)
            )
          )
        ),
        h(
          "tbody",
          null,
          reports.map((row) =>
            h(
              "tr",
              { key: row.questionId },
              h("td", null, row.question?.text || row.questionId),
              h("td", null, row.question?.language || "Unknown"),
              h("td", null, row.question?.level || "-"),
              h("td", null, h("span", { className: "count-pill" }, number(row.reportCount))),
              h("td", null, row.latestReason || "No reason"),
              h("td", null, date(row.latestReportedAt)),
              h(
                "td",
                null,
                h(
                  "div",
                  { className: "row-actions" },
                  h("button", {
                    className: "secondary-button small-button",
                    type: "button",
                    onClick: () => {
                      const snapshot = buildReportedQuestionSnapshot(row);
                      setPendingQuestionEdit({ id: row.questionId, snapshot });
                      setActiveView("questions");
                    },
                  }, "Edit"),
                  h("button", { className: "ghost-button small-button", type: "button", onClick: () => remove(row) }, "Delete")
                )
              )
            )
          )
        )
      ),
      reports.length === 0 && h("p", { className: "empty table-empty" }, "No reported questions yet.")
    ),
    h("p", { className: message === "Question deleted." ? "message success" : "message danger" }, message)
  );
}

function UsersView({ api }) {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const query = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
      const data = await api(`/admin/api/users${query}`);
      setUsers(data.users || []);
    } catch (err) {
      setMessage(err.message);
    }
  }, [api, search]);

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  async function ban(user) {
    const reason = prompt(`Ban ${user.name}? Reason:`, "Account suspended");
    if (reason === null) return;
    try {
      await api(`/admin/api/users/${encodeURIComponent(user.userId)}/ban`, {
        method: "PATCH",
        body: JSON.stringify({ reason }),
      });
      setMessage("User banned.");
      await load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function unban(user) {
    if (!confirm(`Unban ${user.name}?`)) return;
    try {
      await api(`/admin/api/users/${encodeURIComponent(user.userId)}/unban`, {
        method: "PATCH",
      });
      setMessage("User unbanned.");
      await load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  return h(
    "section",
    { className: "view active" },
    h(Header, {
      title: "Users",
      subtitle: "Search accounts and manage bans.",
    }),
    h(
      "div",
      { className: "toolbar" },
      h("input", {
        value: search,
        placeholder: "Search name or email",
        onChange: (event) => setSearch(event.target.value),
      }),
      h("button", { className: "secondary-button", type: "button", onClick: load }, "Refresh")
    ),
    h(
      "section",
      { className: "table-panel" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            ["Name", "Email", "Rating", "Role", "Last seen", "Status", "Action"].map((label) =>
              h("th", { key: label }, label)
            )
          )
        ),
        h(
          "tbody",
          null,
          users.map((user) =>
            h(
              "tr",
              { key: user.userId },
              h("td", null, user.name),
              h("td", null, user.email),
              h("td", null, number(user.rating)),
              h("td", null, user.role || "user"),
              h("td", null, date(user.lastSeen)),
              h("td", null, user.banned ? h("span", { className: "pill danger" }, user.banReason || "Banned") : h("span", { className: "pill" }, "Active")),
              h(
                "td",
                null,
                h(
                  "button",
                  {
                    className: user.banned ? "secondary-button small-button" : "ghost-button small-button",
                    type: "button",
                    onClick: () => (user.banned ? unban(user) : ban(user)),
                  },
                  user.banned ? "Unban" : "Ban"
                )
              )
            )
          )
        )
      )
    ),
    h("p", { className: message.includes("banned") ? "message success" : "message danger" }, message)
  );
}

function Header({ title, subtitle, children }) {
  return h(
    "header",
    { className: "view-header" },
    h("div", null, h("h1", null, title), h("p", null, subtitle)),
    children && h("div", { className: "header-actions" }, children)
  );
}

function TextField({ label, id, value, placeholder, onChange }) {
  return h(
    "label",
    null,
    label,
    h("input", {
      id,
      value: value || "",
      placeholder,
      onChange: (event) => onChange(event.target.value),
    })
  );
}

function TextAreaField({ label, id, value, rows, placeholder, onChange }) {
  return h(
    "label",
    null,
    label,
    h("textarea", {
      id,
      value: value || "",
      rows,
      placeholder,
      onChange: (event) => onChange(event.target.value),
    })
  );
}

function SelectField({ label, value, options, onChange }) {
  return h(
    "label",
    null,
    label,
    h(InlineSelect, { value, options, onChange })
  );
}

function InlineSelect({ value, options, onChange }) {
  return h(
    "select",
    { value: value || "", onChange: (event) => onChange(event.target.value) },
    options.map(([optionValue, label]) =>
      h("option", { key: `${optionValue}-${label}`, value: optionValue }, label)
    )
  );
}

function asLines(value) {
  if (Array.isArray(value)) return value.map((item) => item.toString().trim()).filter(Boolean);
  return (value || "")
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeOptionRows(value) {
  const rows = Array.isArray(value)
    ? value.map((item) => item.toString())
    : (value || "").toString().split("\n");
  while (rows.length < 2) rows.push("");
  return rows;
}

function normalizeOptions(value) {
  return unique(normalizeOptionRows(value).map((option) => option.trim()).filter(Boolean));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readPendingQuestionSnapshot(focusId) {
  const raw = sessionStorage.getItem("admin_question_snapshot");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.id !== focusId) return null;
    return {
      ...EMPTY_QUESTION,
      ...parsed,
      options: parsed.options || EMPTY_QUESTION.options,
      correctAnswers: parsed.correctAnswers || [],
    };
  } catch (_) {
    return null;
  }
}

function buildReportedQuestionSnapshot(row) {
  const question = row.question || {};
  return {
    ...EMPTY_QUESTION,
    ...question,
    id: row.questionId,
    text: question.text || row.questionId,
    language: question.language || "english",
    level: question.level || "A1",
    type: question.type || "multiple_choice",
    status: question.status === "published" ? "published" : "draft",
    options: Array.isArray(question.options) && question.options.length > 0
      ? question.options
      : [...EMPTY_QUESTION.options],
    correctAnswers: Array.isArray(question.correctAnswers)
      ? question.correctAnswers
      : [],
  };
}

function clearPendingQuestionFocus() {
  sessionStorage.removeItem("admin_question_focus");
  sessionStorage.removeItem("admin_question_snapshot");
}

function asText(value) {
  return Array.isArray(value) ? value.join("\n") : value || "";
}

function humanType(value) {
  return TYPES.find(([key]) => key === value)?.[1] || value || "";
}

function number(value) {
  return Number(value || 0).toLocaleString();
}

function date(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
