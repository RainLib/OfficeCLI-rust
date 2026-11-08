import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {SemanticTextFlow} from './semanticTextFlow.ts'
import {writeSemanticInline} from './semanticInlineContent.ts'

const schema = getSchema(schemaExtensions)
const paragraph = (text: string) => schema.nodes.paragraph.createChecked(null, text ? schema.text(text) : null)
function replica(document: Y.Doc) {
  const carriers = document.getMap<Y.XmlFragment>('carriers')
  const flow = new SemanticTextFlow(document, carriers, schema)
  return {document, carriers, flow, text: (key: string) => flow.read(key).textBetween(0, flow.read(key).size, '\n', '\n')}
}
function fixture(texts = ['ABCD', 'EF', 'GH']) {
  const a = replica(new Y.Doc()), b = replica(new Y.Doc())
  texts.forEach((text, index) => {
    const key = String.fromCharCode(97 + index), fragment = new Y.XmlFragment()
    a.carriers.set(key, fragment); fragment.insert(0, [new Y.XmlText()])
    writeSemanticInline(fragment.get(0) as Y.XmlText, paragraph(text))
  })
  a.flow.initialize([...a.carriers.keys()])
  Y.applyUpdate(b.document, Y.encodeStateAsUpdate(a.document))
  return {a, b, close() { a.document.destroy(); b.document.destroy() }}
}
function exchange(a: Y.Doc, b: Y.Doc, reverse = false) {
  const au = Y.encodeStateAsUpdate(a), bu = Y.encodeStateAsUpdate(b)
  if (reverse) { Y.applyUpdate(b, au); Y.applyUpdate(a, bu) }
  else { Y.applyUpdate(a, bu); Y.applyUpdate(b, au) }
}
function projection(replica: ReturnType<typeof fixture>['a']) {
  return replica.flow.roots().sort().map(root => [root, replica.text(root)])
}

for (const reverse of [false, true]) {
  test(`split routes offline suffix input and its caret to the new flow, reverse=${reverse}`, () => {
    const f = fixture(), history = f.a.flow.undoManager()
    try {
      const original = f.a.carriers.get('a')!.get(0)
      const bookmark = f.b.flow.capture('a', 4)
      f.a.flow.split('a', 2, 'x')
      f.b.flow.write('a', paragraph('ABC Peer!D'))
      exchange(f.a.document, f.b.document, reverse)
      assert.equal(f.a.text('a'), 'AB'); assert.equal(f.a.text('x'), 'C Peer!D')
      assert.deepEqual(projection(f.a), projection(f.b))
      assert.equal(f.a.flow.resolve(bookmark)!.root, 'x')
      assert.equal(f.a.carriers.get('a')!.get(0), original)
      assert.equal(history.undoStack.length, 1)
      history.undo(); exchange(f.a.document, f.b.document, reverse)
      assert.equal(f.a.text('a'), 'ABC Peer!D'); assert.equal(f.a.flow.resolve(bookmark)!.root, 'a')
      history.redo(); exchange(f.a.document, f.b.document, reverse)
      assert.equal(f.a.text('x'), 'C Peer!D'); assert.deepEqual(projection(f.a), projection(f.b))
    } finally { history.destroy(); f.close() }
  })
  test(`join keeps an offline source edit and maps its caret into the target, reverse=${reverse}`, () => {
    const f = fixture(), history = f.a.flow.undoManager()
    try {
      const source = f.a.carriers.get('b')!.get(0), bookmark = f.b.flow.capture('b', 2)
      f.a.flow.join('a', 'b', '\n'); f.b.flow.write('b', paragraph('E Peer!F'))
      exchange(f.a.document, f.b.document, reverse)
      assert.equal(f.a.text('a'), 'ABCD\nE Peer!F'); assert.equal(f.a.flow.rootFor('b'), 'a')
      assert.deepEqual(f.a.flow.resolve(bookmark), {root: 'a', offset: 'ABCD\nE Peer!F'.length})
      assert.equal(f.a.carriers.get('b')!.get(0), source)
      history.undo(); exchange(f.a.document, f.b.document, reverse)
      assert.equal(f.a.text('a'), 'ABCD'); assert.equal(f.a.text('b'), 'E Peer!F')
      history.redo(); exchange(f.a.document, f.b.document, reverse)
      assert.equal(f.a.text('a'), 'ABCD\nE Peer!F'); assert.deepEqual(projection(f.a), projection(f.b))
    } finally { history.destroy(); f.close() }
  })
  test(`overlapping concurrent joins retain the entire continuation, reverse=${reverse}`, () => {
    const f = fixture()
    try {
      f.a.flow.join('a', 'b'); f.b.flow.join('b', 'c')
      exchange(f.a.document, f.b.document, reverse)
      assert.deepEqual(projection(f.a), [['a', 'ABCDEFGH']]); assert.deepEqual(projection(f.a), projection(f.b))
    } finally { f.close() }
  })
  test(`concurrent opposite joins break the cycle without losing either carrier, reverse=${reverse}`, () => {
    const f = fixture(['AB', 'CD'])
    try {
      f.a.flow.join('a', 'b'); f.b.flow.join('b', 'a')
      exchange(f.a.document, f.b.document, reverse)
      assert.deepEqual(projection(f.a), [['a', 'ABCD']]); assert.deepEqual(projection(f.a), projection(f.b))
    } finally { f.close() }
  })
  test(`concurrent cuts partition the original carrier exactly once, reverse=${reverse}`, () => {
    const f = fixture(['ABCDEFGH'])
    try {
      f.a.flow.split('a', 2, 'x'); f.b.flow.split('a', 5, 'y')
      exchange(f.a.document, f.b.document, reverse)
      assert.deepEqual(projection(f.a), [['a', 'AB'], ['x', 'CDE'], ['y', 'FGH']])
      assert.deepEqual(projection(f.a), projection(f.b))
      f.a.flow.join('a', 'x'); f.a.flow.join('a', 'y')
      assert.equal(f.a.text('a'), 'ABCDEFGH')
    } finally { f.close() }
  })
}

test('splitting a joined flow moves following branches without copying any text', () => {
  const f = fixture()
  try {
    f.a.flow.join('a', 'b'); f.a.flow.join('a', 'c')
    f.a.flow.split('a', 5, 'x')
    assert.equal(f.a.text('a'), 'ABCDE'); assert.equal(f.a.text('x'), 'FGH')
    assert.equal(f.a.flow.parts('x').length, 2)
    f.a.flow.write('x', paragraph('F New!GH'))
    assert.equal(f.a.text('x'), 'F New!GH')
    f.a.flow.join('a', 'x'); assert.equal(f.a.text('a'), 'ABCDEF New!GH')
  } finally { f.close() }
})

test('undoing a split retains a peer continuation attached to its removed boundary', () => {
  const f = fixture(), history = f.a.flow.undoManager()
  try {
    f.a.flow.split('a', 2, 'x'); exchange(f.a.document, f.b.document)
    f.b.flow.join('x', 'b'); f.b.flow.write('x', paragraph('CD Peer!EF'))
    exchange(f.a.document, f.b.document)
    assert.equal(f.a.text('x'), 'CD Peer!EF')
    history.undo(); exchange(f.a.document, f.b.document)
    assert.equal(f.a.text('a'), 'ABCD Peer!EF'); assert.deepEqual(projection(f.a), projection(f.b))
    history.redo(); exchange(f.a.document, f.b.document)
    assert.equal(f.a.text('x'), 'CD Peer!EF'); assert.deepEqual(projection(f.a), projection(f.b))
  } finally { history.destroy(); f.close() }
})

test('formatting and edits across several parts skip internal boundaries and preserve emoji and leaf nodes', () => {
  const f = fixture(['A😀B', 'CD'])
  try {
    f.a.flow.split('a', 3, 'x'); f.a.flow.join('a', 'x'); f.a.flow.join('a', 'b')
    const rich = schema.nodes.paragraph.createChecked(null, [schema.text('A😀', [schema.marks.bold.create()]), schema.nodes.hardBreak.create(), schema.text('D')])
    f.a.flow.write('a', rich)
    assert.ok(f.a.flow.read('a').eq(rich.content))
    const snapshot = Y.encodeStateAsUpdate(f.a.document), vector = Y.encodeStateVector(f.a.document)
    const recovered = replica(new Y.Doc()); Y.applyUpdate(recovered.document, snapshot)
    assert.ok(recovered.flow.read('a').eq(rich.content)); assert.deepEqual(projection(f.a), projection(recovered))
    f.a.flow.read('a'); f.a.flow.parts('a'); assert.deepEqual(Y.encodeStateVector(f.a.document), vector)
    recovered.document.destroy()
  } finally { f.close() }
})

test('deletion across reversed physical slices uses descending carrier offsets', () => {
  const f = fixture(['ABCDEFGH'])
  try {
    f.a.flow.split('a', 4, 'x'); f.a.flow.join('x', 'a')
    assert.equal(f.a.text('x'), 'EFGHABCD')
    f.a.flow.write('x', paragraph('EXD')); assert.equal(f.a.text('x'), 'EXD')
  } finally { f.close() }
})

test('unknown boundary versions reject projection without changing shared bytes', () => {
  const f = fixture()
  try {
    const text = f.a.carriers.get('a')!.get(0) as Y.XmlText
    text.insertEmbed(1, {hcdTextBoundary: {version: 99, key: 'future'}})
    const bytes = Y.encodeStateAsUpdate(f.a.document)
    assert.throws(() => f.a.flow.read('a'), /invalidTextBoundary/)
    assert.deepEqual(Y.encodeStateAsUpdate(f.a.document), bytes)
  } finally { f.close() }
})

test('three offline replicas retain every inserted character through repeated splits, joins and shuffled updates', () => {
  for (let seed = 1; seed <= 8; seed++) {
    let randomState = seed
    const random = (limit: number) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % limit }
    const fixtureState = fixture(), third = replica(new Y.Doc())
    Y.applyUpdate(third.document, Y.encodeStateAsUpdate(fixtureState.a.document))
    const replicas = [fixtureState.a, fixtureState.b, third], inserted = [...'ABCDEFGH']
    const multiset = (text: string) => [...text].sort().join('')
    try {
      for (let step = 0; step < 60; step++) {
        const client = random(3), current = replicas[client], roots = current.flow.roots(), root = roots[random(roots.length)]
        const text = current.text(root), character = String.fromCharCode(0xe000 + step)
        current.flow.write(root, paragraph(text + character)); inserted.push(character)
        if (random(2) && roots.length > 1) {
          const other = roots.filter(key => key !== root)
          current.flow.join(root, other[random(other.length)])
        } else current.flow.split(root, random(text.length + 2), `split-${seed}-${client}-${step}`)
        if (random(3)) {
          const other = (client + 1 + random(2)) % 3, update = Y.encodeStateAsUpdate(current.document)
          Y.applyUpdate(replicas[other].document, update)
          if (random(2)) Y.applyUpdate(replicas[other].document, update)
        }
      }
      const updates = replicas.map(replica => Y.encodeStateAsUpdate(replica.document))
      replicas.forEach((replica, index) => [...updates.slice(index), ...updates.slice(0, index)].reverse().forEach(update => Y.applyUpdate(replica.document, update)))
      for (const current of replicas) {
        const projected = current.flow.roots().map(root => current.text(root)).join('')
        assert.equal(multiset(projected), multiset(inserted.join('')), `seed ${seed}: every character must occur exactly once`)
        assert.deepEqual(projection(current), projection(replicas[0]))
      }
    } finally { fixtureState.close(); third.document.destroy() }
  }
})
