import { describe, expect, it } from 'vitest'
import { diagnoseNoUtterances, pipelineStages, waitedSeconds } from './onboarding'

const c = (o: object) => ({ counts: { pending: 0, processing: 0, done: 0, failed: 0, skipped: 0, ...o }, errors: [] })

describe('diagnoseNoUtterances', () => {
  it('failed chunks come first', () => expect(diagnoseNoUtterances(c({ failed: 1, pending: 3 }))).toBe('failed'))
  it('no chunks at all means the recorder sends nothing', () => expect(diagnoseNoUtterances(c({}))).toBe('no_chunks'))
  it('queued but never completed means ASR is stuck', () => expect(diagnoseNoUtterances(c({ pending: 2 }))).toBe('asr_stuck'))
  it('skipped chunks mean the filter ate the sound', () => expect(diagnoseNoUtterances(c({ skipped: 2, done: 1 }))).toBe('skipped'))
  it('unknown when processed but nothing explains it', () => expect(diagnoseNoUtterances(c({ done: 2 }))).toBe('unknown'))
  it('unknown without data', () => expect(diagnoseNoUtterances(undefined)).toBe('unknown'))
})

describe('pipelineStages', () => {
  it('lights up recording, uploaded and ASR in turn', () => {
    expect(pipelineStages(true, c({}))).toEqual([true, false, false])
    expect(pipelineStages(true, c({ pending: 1 }))).toEqual([true, true, false])
    expect(pipelineStages(true, c({ pending: 1, processing: 1 }))).toEqual([true, true, true])
    expect(pipelineStages(false, undefined)).toEqual([false, false, false])
  })
})

describe('waitedSeconds', () => {
  it('counts whole seconds and never goes negative', () => {
    expect(waitedSeconds(1000, 91_500)).toBe(90)
    expect(waitedSeconds(5000, 1000)).toBe(0)
  })
})
