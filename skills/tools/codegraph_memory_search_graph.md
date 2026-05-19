---
name: codegraph-memory-search-graph-guidance
type: tool-guidance
target_tool: codebase_memory_search_graph
priority: 10
token_cost: 150
user-invocable: false
---
## Codebase Memory Search Graph Tool
Search the code knowledge graph for functions, classes, routes, and variables. This is a **structural code search** — it understands code relationships, not just text.

REQUIRED: project (project name)
OPTIONAL: query (natural-language or keyword search), name_pattern (regex), file_pattern (glob), semantic_query (array of keywords for vector search), relationship (filter by relationship type), limit, offset

RULES:
- Use `query` for BM25 ranked full-text search with camelCase splitting (e.g. "updateCloudClient" matches "update", "cloud", "client")
- Use `semantic_query` for vector cosine search that bridges vocabulary (e.g. ["send", "pubsub", "publish"] finds "publish" functions)
- Use `name_pattern` for exact regex matching on symbol names
- Use `relationship` to filter by call graph, type hierarchy, imports, etc.
- Results are ranked with structural boosting: Functions/Methods +10, Routes +8, Classes/Interfaces +5

WHEN TO USE codebase_memory_search_graph:
- "Where is function X defined?" / "Find the implementation of Y"
- "What calls function X?" / "Who uses class Y?"
- "Find all usages/references of Z"
- "What does this function call?" / "Show me the call graph"
- "Find all subclasses/implementors of interface X"
- Any question about code structure, dependencies, or relationships

WHEN TO USE Grep INSTEAD:
- You need raw text search (strings, comments, literals)
- You're searching for a specific string pattern, not a code symbol
- You need regex across all file types including non-code

WHEN TO USE FindRead INSTEAD:
- You already know which files you need to read
- You need to see the full file contents, not just symbol locations

EXAMPLE (find function definition):
```tool
{"name": "codebase_memory_search_graph", "input": {"project": "my-project", "query": "updateUserSettings"}}
```

EXAMPLE (what calls a function):
```tool
{"name": "codebase_memory_search_graph", "input": {"project": "my-project", "query": "validateInput", "relationship": "calls"}}
```

EXAMPLE (semantic search):
```tool
{"name": "codebase_memory_search_graph", "input": {"project": "my-project", "semantic_query": ["send", "pubsub", "publish"]}}
```
