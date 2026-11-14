import { expect, test } from 'bun:test'
import { PIPELINE_SCENES, sceneFor } from '../src/board/scenes'
import { drawFrame, framesOf, scenes } from '../src/kit/sprites'
import type { TaskPhase } from '../src/lib/phases'

const WORKING: [TaskPhase, string][] = [
  ['research', 'research'], ['spec', 'spec'], ['spec-review', 'spec-review'], ['plan', 'plan'],
  ['plan-review', 'plan-review'], ['implement', 'working'], ['pr-review', 'pr-review'],
  ['pr-review-intent', 'pr-review'], ['pr-review-quality', 'pr-review'], ['ci', 'ci'],
  ['land-queue', 'land-queue'], ['sync', 'sync'], ['merge', 'merge'], ['close', 'close'], ['teardown', 'close'],
]

test('every working phase has its scene, including the retired review variants and teardown', () => {
  for (const [phase, scene] of WORKING) expect(sceneFor({ phase, decision_from: null })).toBe(scene)
})

test('a task waiting on the orchestrator keeps the scene of what it was doing', () => {
  expect(sceneFor({ phase: 'blocked-on-decision', decision_from: 'plan' })).toBe('plan')
  expect(sceneFor({ phase: 'blocked-on-decision', decision_from: null })).toBe('working')
})

test('the 11 new scenes are registered with 4 frames each', () => {
  expect(PIPELINE_SCENES).toHaveLength(11)
  for (const name of PIPELINE_SCENES) {
    expect(scenes()).toContain(name)
    expect(framesOf(name)).toBe(4)
  }
})

const HAT = [0xf9, 0xe2, 0xaf]

test('every loop frame shows the hard hat', () => {
  for (const name of PIPELINE_SCENES) {
    for (let f = 0; f < 4; f++) {
      const px = drawFrame(name, f, 'hardhat', false)
      let hat = 0
      for (let i = 0; i < px.length; i += 4) if (px[i] === HAT[0] && px[i + 1] === HAT[1] && px[i + 2] === HAT[2]) hat++
      expect({ name, f, hat: hat >= 20 }).toEqual({ name, f, hat: true })
    }
  }
})
