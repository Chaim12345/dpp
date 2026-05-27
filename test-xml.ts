import { XmlToolCallParser } from './src/xml-toolcall-parser.js';

async function run() {
  let passed = 0, failed = 0;
  function check(label: string, actual: any, expected: any) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log('PASS: ' + label); passed++; }
    else { console.log('FAIL: ' + label); console.log('  expected: ' + e); console.log('  actual:   ' + a); failed++; }
  }

  // Test 1: tool_call with param
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool_calls\x3E\x3Ctool_call name="read"\x3E\x3Cparam name="path"\x3E/root/test.json\x3C/param\x3E\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('tool_call with param', p.getToolCalls(), [{name:'read',arguments:{path:'/root/test.json'}}]);
    p.destroy();
  }

  // Test 2: tool_call with multiple params
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool_calls\x3E\x3Ctool_call name="edit"\x3E\x3Cparam name="filePath"\x3E/root/test.ts\x3C/param\x3E\x3Cparam name="oldString"\x3Efoo\x3C/param\x3E\x3Cparam name="newString"\x3Ebar\x3C/param\x3E\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('tool_call with multiple params', p.getToolCalls(), [{name:'edit',arguments:{filePath:'/root/test.ts',oldString:'foo',newString:'bar'}}]);
    p.destroy();
  }

  // Test 3: tool_call with JSON body (no params)
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool_calls\x3E\x3Ctool_call name="bash"\x3E{"command":"ls"}\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('tool_call with JSON body', p.getToolCalls(), [{name:'bash',arguments:{command:'ls'}}]);
    p.destroy();
  }

  // Test 4: invoke with parameter children
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Cinvoke name="read"\x3E\x3Cparameter name="path"\x3E/root/test.json\x3C/parameter\x3E\x3C/invoke\x3E');
    p.end();
    check('invoke with parameter', p.getToolCalls(), [{name:'read',arguments:{path:'/root/test.json'}}]);
    p.destroy();
  }

  // Test 5: multiple tool_calls with param
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool_calls\x3E\x3Ctool_call name="read"\x3E\x3Cparam name="path"\x3Ea.ts\x3C/param\x3E\x3C/tool_call\x3E\x3Ctool_call name="read"\x3E\x3Cparam name="path"\x3Eb.ts\x3C/param\x3E\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('multiple tool_calls', p.getToolCalls(), [{name:'read',arguments:{path:'a.ts'}},{name:'read',arguments:{path:'b.ts'}}]);
    p.destroy();
  }

  // Test 6: raw body fallback
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool_calls\x3E\x3Ctool_call name="search"\x3Esome plain text\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('raw body fallback', p.getToolCalls(), [{name:'search',arguments:{raw:'some plain text'}}]);
    p.destroy();
  }

  // Test 7: incremental feeding (simulating stream)
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool');
    p.feed('_calls\x3E\x3Cto');
    p.feed('ol_call name="read"\x3E');
    p.feed('\x3Cparam name="path"\x3E/root/test.json\x3C/param\x3E');
    p.feed('\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('incremental feeding', p.getToolCalls(), [{name:'read',arguments:{path:'/root/test.json'}}]);
    p.destroy();
  }

  // Test 8: parameter inside tool_call (long form)
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool_calls\x3E\x3Ctool_call name="read"\x3E\x3Cparameter name="path"\x3E/root/test.json\x3C/parameter\x3E\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('parameter inside tool_call', p.getToolCalls(), [{name:'read',arguments:{path:'/root/test.json'}}]);
    p.destroy();
  }

  // Test 9: param with JSON value (should parse)
  {
    const p = new XmlToolCallParser(); await p.init();
    p.feed('\x3Ctool_calls\x3E\x3Ctool_call name="bash"\x3E\x3Cparam name="command"\x3Els -la\x3C/param\x3E\x3C/tool_call\x3E\x3C/tool_calls\x3E');
    p.end();
    check('param with string value', p.getToolCalls(), [{name:'bash',arguments:{command:'ls -la'}}]);
    p.destroy();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
