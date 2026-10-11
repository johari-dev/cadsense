// expect: 6:13 unterminated-string
// expect: 6:18 expected
FeatureScript 3083;
function f()
{
    var s = "abc;
    return s;
}
