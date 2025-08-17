# DocsSidebar v2 - React Complex Tree Implementation

This module implements a Notion-like file explorer using React Complex Tree library with Convex backend, Liveblocks real-time collaboration, and AI-powered document features.

## Architecture Stack

```
┌─────────────────────────────────────────────────────────┐
│                    User Interface                        │
│  React Complex Tree + shadcn/ui + Tailwind CSS          │
├─────────────────────────────────────────────────────────┤
│                  State Management                        │
│  Local Context (Navigation) + DocsSearchContext         │
├─────────────────────────────────────────────────────────┤
│                 Real-time Collaboration                  │
│         Liveblocks (Yjs + TipTap Editor)                │
├─────────────────────────────────────────────────────────┤
│                   Data Persistence                       │
│          Convex (Database + HTTP Actions)               │
├─────────────────────────────────────────────────────────┤
│                    AI Integration                        │
│        Novel Editor + Contextual AI Prompts             │
└─────────────────────────────────────────────────────────┘
```

## Key Components

### `DocsSidebar` (Main Export)

- **File**: `docs-sidebar-v2.tsx`
- **Purpose**: Main wrapper component that provides sidebar structure
- **Props**: Extends Sidebar props with `onClose` callback
- **Dependencies**: Uses SidebarProvider, DocsSearchContextProvider

### `DocsSearchContextProvider`

- **Purpose**: Manages search state, archived items, and data provider reference
- **State**:
  - `searchQuery`: Current search text
  - `archivedItems`: Set of archived document IDs
  - `showArchived`: Boolean toggle for archived visibility
  - `dataProviderRef`: Reference to NotionLikeDataProvider instance

### `TreeArea` (Core Tree Implementation)

- **Purpose**: Renders the UncontrolledTreeEnvironment with custom logic
- **Key Features**:
  - Uses `InteractionMode.ClickArrowToExpand` (VSCode-like behavior)
  - Implements drag & drop to root area
  - Custom search filtering via `shouldRenderChildren`
  - Archive/unarchive functionality
  - Auto-expansion of root-level folders

### `TreeItem` (Custom Item Renderer)

- **Purpose**: Renders individual tree items with action buttons
- **Features**:
  - Primary action area with file icon and title
  - Action buttons: Add child, Rename, Archive/Unarchive
  - Supports archived state with visual indicators
  - Proper click forwarding without hooks violations

## Data Flow

1. **Data Provider**: `NotionLikeDataProvider` manages tree data with automatic alphabetical sorting
2. **Selection**: Uses `useDocumentNavigation()` hook for external navigation
3. **Filtering**: Combines search query and archive visibility in `shouldRenderChildren`
4. **Actions**: Add, rename, archive operations update data provider
5. **Persistence**: Changes sync to Convex database via mutations
6. **Real-time Sync**: Liveblocks provides collaborative editing with Yjs

## Key Patterns Used

### ✅ Correct Interaction Mode

```typescript
defaultInteractionMode={InteractionMode.ClickArrowToExpand}
onPrimaryAction={handlePrimaryAction}
```

### ✅ Proper Component Extraction (No Hooks in renderItem)

```typescript
renderItem={(props) => (
  <TreeItem
    {...props}
    selectedDocId={selectedDocId}
    archivedItems={archivedItems}
    onAdd={handleAddChild}
    onArchive={handleArchive}
    onUnarchive={handleUnarchive}
  />
)}
```

### ✅ Stable Data Provider

```typescript
const dataProvider = useMemo(() => {
	const provider = new NotionLikeDataProvider(createTreeDataWithPlaceholders());
	if (!dataProviderRef.current) {
		dataProviderRef.current = provider;
	}
	return provider;
}, []); // Empty deps - created once
```

### ✅ Filtering Architecture

- **Structural filtering** (search): `shouldRenderChildren`
- **Individual visibility** (archived): `renderItem` returning `null`

## CSS Classes

Uses systematic CSS class naming with `DocsSidebar_ClassNames` type for maintainability:

- `DocsSidebar-tree-area`
- `DocsSidebar-tree-container`
- `DocsSidebar-tree-item`
- `DocsSidebar-selection-counter`

## Integration Points

- **Navigation**: `useDocumentNavigation()` hook
- **Data**: `createTreeDataWithPlaceholders()` and `NotionLikeDataProvider`
- **Styling**: Uses Tailwind with custom CSS variables
- **UI Components**: Integrates with shadcn/ui sidebar components
- **Backend**: Convex for persistence (`ai_docs_temp.ts`)
- **Real-time**: Liveblocks for collaboration
- **AI**: Novel Editor with contextual prompts

## Anti-Patterns Avoided

- ❌ No hooks directly in `renderItem` callback
- ❌ No custom click handlers with complex event logic
- ❌ No filtering in `getTreeItem` method
- ❌ No unstable data provider instances

## Advanced Features

### Drag & Drop to Root Area

Custom implementation allows dropping items directly onto empty space:

- Tracks drag state with `isDraggingOverRootArea`
- Accesses internal `dragAndDropContext.draggingItems`
- Batch updates parent-child relationships
- Maintains alphabetical sorting after drop

### Multi-Selection Operations

- Selection counter shows when 2+ items selected
- Bulk archive/unarchive functionality
- Clear selection action
- Keyboard shortcuts support

### Search with Hierarchical Filtering

- Real-time search as you type
- Filters children based on title match
- Preserves folder structure during search
- Placeholder items always visible

## Convex Backend Integration

### Database Schema

```typescript
docs_yjs: defineTable({
	roomId: v.string(),
	content: v.bytes(), // Yjs document state
	orgId: v.string(),
	projectId: v.string(),
	docId: v.string(),
}).index("by_room_id", ["roomId"]);
```

### HTTP Actions

- `ai_docs_temp_liveblocks_auth`: JWT authentication for Liveblocks
- `ai_docs_temp_contextual_prompt`: AI generation endpoint
- `ai_docs_temp_liveblocks_webhook`: Persistence webhook
- `ai_docs_temp_upsert_yjs_document`: Save document changes

## Liveblocks Real-time Collaboration

### Room Setup

```typescript
// Room ID pattern: orgId:projectId:docId
const roomId = `${orgId}:${projectId}:${selectedDocId}`;

<LiveblocksRoomProvider roomId={roomId}>
  <TipTapEditor
    extensions={[LiveblocksYjsExtension]}
    initialContent={documentContent}
  />
</LiveblocksRoomProvider>
```

### Authentication Flow

- JWT tokens generated via Convex HTTP action
- Webhook for automatic persistence to database
- Yjs for conflict-free concurrent editing

## AI Features Integration

### Contextual AI Operations

```typescript
const AI_OPERATIONS = {
	continue: "Continue writing from current position",
	improve: "Improve selected text",
	shorter: "Make text more concise",
	longer: "Expand on the text",
	fix: "Fix grammar and spelling",
	zap: "Custom command generation",
};
```

### AI Resolver

- Integrates with Novel Editor
- Sends context to Convex HTTP endpoint
- Streams responses back to editor
- Auto-saves generated content via Liveblocks

## Performance Optimizations

1. **Memoized Computations**: Expensive operations cached with `useMemo`
2. **Stable References**: Data provider and handlers have stable identities
3. **Efficient Filtering**: Uses `shouldRenderChildren` for structural filtering
4. **Lazy Loading**: TipTap editor loaded dynamically on document selection
5. **Batch Updates**: Multiple tree operations batched in promises
6. **15-minute Cache**: Web fetch results cached for repeated access

## Testing Considerations

When modifying the sidebar:

1. **Drag & Drop**: Test dropping to root area and between folders
2. **Search**: Verify filtering works with nested items
3. **Archive**: Check multi-selection archive/unarchive
4. **Placeholders**: Ensure they appear/disappear correctly
5. **Sorting**: Validate alphabetical order maintained
6. **Real-time**: Test sync with multiple users
7. **AI Features**: Verify generation and insertion

## Extension Points

The architecture supports future enhancements:

1. **Custom node types**: Add via `DocData.type` enum
2. **AI operations**: Extend contextual prompts
3. **New actions**: Add buttons to TreeItem component
4. **Enhanced search**: Implement content-based search
5. **Permissions**: Add access control to operations
6. **Version history**: Track document changes over time
7. **Offline support**: Cache and sync when reconnected

This implementation follows react-complex-tree best practices for a production-ready, enterprise-grade document management system with sophisticated file organization, real-time collaboration, and AI assistance capabilities.
