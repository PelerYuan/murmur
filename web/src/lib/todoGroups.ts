import type { Todo } from './types'

export type TodoGroup = 'overdue' | 'today' | 'later' | 'nodue'

export function groupTodos(todos: Todo[], nowMs: number, todayEndMs: number): Record<TodoGroup, Todo[]> {
  const g: Record<TodoGroup, Todo[]> = { overdue: [], today: [], later: [], nodue: [] }
  for (const td of todos) {
    if (!td.due_at) { g.nodue.push(td); continue }
    const d = Date.parse(td.due_at)
    if (d < nowMs) g.overdue.push(td)
    else if (d < todayEndMs) g.today.push(td)
    else g.later.push(td)
  }
  const byDue = (a: Todo, b: Todo) => Date.parse(a.due_at ?? '') - Date.parse(b.due_at ?? '')
  g.overdue.sort(byDue); g.today.sort(byDue); g.later.sort(byDue)
  return g
}
