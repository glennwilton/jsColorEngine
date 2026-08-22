// Generate tetra5d_nch.wat / tetra6d_nch.wat from tetra4d_nch.wat.
// Extra planes fold into $K0 so the 6-case tetra body is copied, not unrolled.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'kernels', '4d', 'tetra4d_nch.wat');
const src = fs.readFileSync(SRC, 'utf8');

const TAIL_RE = /\(\s*if \(i32\.eq \(local\.get \$tailMode\) \(i32\.const 1\)\)[\s\S]*?local\.get \$outputPos i32\.const 1 i32\.add\s+local\.set \$outputPos\)\)/;

const FINISH5_CALL = `(call $finish5
                                        (local.get $u20) (local.get $o)
                                        (local.get $kpass) (local.get $interpK)
                                        (local.get $epass) (local.get $interpE)
                                        (local.get $rk) (local.get $re)
                                        (local.get $scratchPtr) (local.get $cMax)
                                        (local.get $outputPos))
                                    local.set $outputPos`;

const FINISH6_CALL = `(call $finish6
                                        (local.get $u20) (local.get $o)
                                        (local.get $kpass) (local.get $interpK)
                                        (local.get $epass) (local.get $interpE)
                                        (local.get $fpass) (local.get $interpF)
                                        (local.get $rk) (local.get $re) (local.get $rf)
                                        (local.get $scratchPtr) (local.get $cMax)
                                        (local.get $outputPos))
                                    local.set $outputPos`;

const FINISH5 = `
    ;; Apply K then E peels. Inner peels stay in u20; the last active peel
    ;; uses the 4D >>20 landing (or >>12 when no peel ran).
    (func $finish5
        (param $u20 i32) (param $o i32)
        (param $kpass i32) (param $interpK i32)
        (param $epass i32) (param $interpE i32)
        (param $rk i32) (param $re i32)
        (param $scratchPtr i32) (param $cMax i32)
        (param $outputPos i32)
        (result i32)
        (local $lo i32) (local $u8 i32)

        (if (i32.and (i32.eqz (local.get $kpass)) (local.get $interpK))
            (then
                (i32.store
                    (i32.add (local.get $scratchPtr) (i32.shl (local.get $o) (i32.const 2)))
                    (local.get $u20))
                (return (local.get $outputPos))))

        (if (local.get $kpass)
            (then
                (local.set $lo (i32.load (i32.add (local.get $scratchPtr) (i32.shl (local.get $o) (i32.const 2)))))
                (local.set $u20
                    (i32.add (local.get $lo)
                        (i32.shr_s
                            (i32.add (i32.mul (i32.sub (local.get $u20) (local.get $lo)) (local.get $rk)) (i32.const 0x80))
                            (i32.const 8))))))

        (if (i32.and (i32.eqz (local.get $epass)) (local.get $interpE))
            (then
                (i32.store
                    (i32.add (local.get $scratchPtr)
                        (i32.shl (i32.add (local.get $cMax) (local.get $o)) (i32.const 2)))
                    (local.get $u20))
                (return (local.get $outputPos))))

        (if (local.get $epass)
            (then
                (local.set $lo (i32.load
                    (i32.add (local.get $scratchPtr)
                        (i32.shl (i32.add (local.get $cMax) (local.get $o)) (i32.const 2)))))
                (local.set $u8
                    (i32.shr_s
                        (i32.add
                            (i32.add (i32.shl (local.get $lo) (i32.const 8))
                                (i32.mul (i32.sub (local.get $u20) (local.get $lo)) (local.get $re)))
                            (i32.const 0x80000))
                        (i32.const 20))))
            (else
                (local.set $u8 (i32.shr_s (i32.add (local.get $u20) (i32.const 0x800)) (i32.const 12)))))

        (local.set $u8 (select (i32.const 0) (local.get $u8) (i32.lt_s (local.get $u8) (i32.const 0))))
        (local.set $u8 (select (i32.const 255) (local.get $u8) (i32.ge_s (local.get $u8) (i32.const 256))))
        (i32.store8 (local.get $outputPos) (local.get $u8))
        (i32.add (local.get $outputPos) (i32.const 1)))
`;

const FINISH6 = `
    (func $finish6
        (param $u20 i32) (param $o i32)
        (param $kpass i32) (param $interpK i32)
        (param $epass i32) (param $interpE i32)
        (param $fpass i32) (param $interpF i32)
        (param $rk i32) (param $re i32) (param $rf i32)
        (param $scratchPtr i32) (param $cMax i32)
        (param $outputPos i32)
        (result i32)
        (local $lo i32) (local $u8 i32)

        (if (i32.and (i32.eqz (local.get $kpass)) (local.get $interpK))
            (then
                (i32.store
                    (i32.add (local.get $scratchPtr) (i32.shl (local.get $o) (i32.const 2)))
                    (local.get $u20))
                (return (local.get $outputPos))))
        (if (local.get $kpass)
            (then
                (local.set $lo (i32.load (i32.add (local.get $scratchPtr) (i32.shl (local.get $o) (i32.const 2)))))
                (local.set $u20
                    (i32.add (local.get $lo)
                        (i32.shr_s
                            (i32.add (i32.mul (i32.sub (local.get $u20) (local.get $lo)) (local.get $rk)) (i32.const 0x80))
                            (i32.const 8))))))

        (if (i32.and (i32.eqz (local.get $epass)) (local.get $interpE))
            (then
                (i32.store
                    (i32.add (local.get $scratchPtr)
                        (i32.shl (i32.add (local.get $cMax) (local.get $o)) (i32.const 2)))
                    (local.get $u20))
                (return (local.get $outputPos))))
        (if (local.get $epass)
            (then
                (local.set $lo (i32.load
                    (i32.add (local.get $scratchPtr)
                        (i32.shl (i32.add (local.get $cMax) (local.get $o)) (i32.const 2)))))
                (local.set $u20
                    (i32.add (local.get $lo)
                        (i32.shr_s
                            (i32.add (i32.mul (i32.sub (local.get $u20) (local.get $lo)) (local.get $re)) (i32.const 0x80))
                            (i32.const 8))))))

        (if (i32.and (i32.eqz (local.get $fpass)) (local.get $interpF))
            (then
                (i32.store
                    (i32.add (local.get $scratchPtr)
                        (i32.shl (i32.add (i32.mul (local.get $cMax) (i32.const 2)) (local.get $o)) (i32.const 2)))
                    (local.get $u20))
                (return (local.get $outputPos))))

        (if (local.get $fpass)
            (then
                (local.set $lo (i32.load
                    (i32.add (local.get $scratchPtr)
                        (i32.shl (i32.add (i32.mul (local.get $cMax) (i32.const 2)) (local.get $o)) (i32.const 2)))))
                (local.set $u8
                    (i32.shr_s
                        (i32.add
                            (i32.add (i32.shl (local.get $lo) (i32.const 8))
                                (i32.mul (i32.sub (local.get $u20) (local.get $lo)) (local.get $rf)))
                            (i32.const 0x80000))
                        (i32.const 20))))
            (else
                (local.set $u8 (i32.shr_s (i32.add (local.get $u20) (i32.const 0x800)) (i32.const 12)))))

        (local.set $u8 (select (i32.const 0) (local.get $u8) (i32.lt_s (local.get $u8) (i32.const 0))))
        (local.set $u8 (select (i32.const 255) (local.get $u8) (i32.ge_s (local.get $u8) (i32.const 256))))
        (i32.store8 (local.get $outputPos) (local.get $u8))
        (i32.add (local.get $outputPos) (i32.const 1)))
`;

function replaceTails(wat, call){
    const next = wat.replace(new RegExp(TAIL_RE.source, 'g'), call);
    const n = (wat.match(new RegExp(TAIL_RE.source, 'g')) || []).length;
    if(n < 6) throw new Error('expected ≥6 tail blocks, found ' + n);
    return next;
}

function patchCommon(wat, dim){
    wat = wat.replace(/tetra4d_nch/g, 'tetra' + dim + 'd_nch');
    wat = wat.replace(/interp_tetra4d_nCh/g, 'interp_tetra' + dim + 'd_nCh');
    wat = wat.replace(/4D tetrahedral/g, dim + 'D tetrahedral');
    return wat;
}

function insertAfter(hay, needle, insert){
    const i = hay.indexOf(needle);
    if(i < 0) throw new Error('missing ' + JSON.stringify(needle.slice(0, 40)));
    return hay.slice(0, i + needle.length) + insert + hay.slice(i + needle.length);
}

function make5(wat){
    wat = patchCommon(wat, 5);
    wat = wat.replace(
        '(param $maxK         i32)\n        (param $scratchPtr   i32)',
        '(param $maxK         i32)\n        (param $go4          i32)\n        (param $maxE         i32)\n        (param $scratchPtr   i32)'
    );
    wat = wat.replace(
        '(local $inputK      i32)',
        '(local $inputE      i32)\n        (local $inputK      i32)'
    );
    wat = wat.replace(
        '(local $pk          i32)',
        '(local $pe          i32)\n        (local $pk          i32)'
    );
    wat = wat.replace(
        '(local $K0          i32)   ;; already scaled by go3 (K0 * go3)',
        '(local $K0          i32)\n        (local $K0base      i32)\n        (local $E0          i32)\n        (local $re          i32)\n        (local $epass       i32)\n        (local $interpE     i32)'
    );
    wat = insertAfter(wat, '(memory (export "memory") 1)\n', FINISH5);

    // 5 input bytes: E, K, C, M, Y
    wat = wat.replace(
`                ;; -- Load 4 u8 input bytes: K, C, M, Y -------------------
                ;; NB: K is FIRST, matching tetrahedralInterp4DArray_*_intLut_loop.
                local.get $inputPos
                i32.load8_u
                local.set $inputK

                local.get $inputPos
                i32.const 1
                i32.add
                i32.load8_u
                local.set $input0

                local.get $inputPos
                i32.const 2
                i32.add
                i32.load8_u
                local.set $input1

                local.get $inputPos
                i32.const 3
                i32.add
                i32.load8_u
                local.set $input2

                local.get $inputPos
                i32.const 4
                i32.add
                local.set $inputPos`,
`                ;; -- Load 5 u8 input bytes: E, K, X, Y, Z ----------------
                local.get $inputPos
                i32.load8_u
                local.set $inputE

                local.get $inputPos
                i32.const 1
                i32.add
                i32.load8_u
                local.set $inputK

                local.get $inputPos
                i32.const 2
                i32.add
                i32.load8_u
                local.set $input0

                local.get $inputPos
                i32.const 3
                i32.add
                i32.load8_u
                local.set $input1

                local.get $inputPos
                i32.const 4
                i32.add
                i32.load8_u
                local.set $input2

                local.get $inputPos
                i32.const 5
                i32.add
                local.set $inputPos`
    );

    wat = wat.replace(
        'local.get $inputK local.get $gps i32.mul local.set $pk',
        'local.get $inputE local.get $gps i32.mul local.set $pe\n                local.get $inputK local.get $gps i32.mul local.set $pk'
    );

    wat = wat.replace(
`                ;; -- Initialise K-plane pass ------------------------------`,
`                ;; -- E-axis boundary patch --------------------------------
                (if (i32.eq (local.get $inputE) (i32.const 255))
                    (then
                        local.get $maxE
                        local.set $E0
                        i32.const 0
                        local.set $re)
                    (else
                        local.get $pe
                        i32.const 16
                        i32.shr_u
                        local.get $go4
                        i32.mul
                        local.set $E0
                        local.get $pe
                        i32.const 8
                        i32.shr_u
                        i32.const 0xFF
                        i32.and
                        local.set $re))
                local.get $re
                i32.const 0
                i32.ne
                local.set $interpE
                local.get $K0
                local.set $K0base
                local.get $K0
                local.get $E0
                i32.add
                local.set $K0
                i32.const 0
                local.set $epass

                ;; -- Initialise K-plane pass ------------------------------`
    );

    wat = wat.replace(
`                (block $k_exit
                    (loop $k_loop`,
`                (block $e_exit
                    (loop $e_loop
                (block $k_exit
                    (loop $k_loop`
    );

    wat = wat.replace(
`                        ;; Fall through to $k_exit.
                        br $k_exit))`,
`                        ;; Fall through to $k_exit.
                        br $k_exit))

                        ;; E-plane: restore K0 to this E + K0, step E, re-enter.
                        (if (i32.and
                                (i32.eqz (local.get $epass))
                                (local.get $interpE))
                            (then
                                local.get $K0base
                                local.get $E0
                                i32.add
                                local.get $go4
                                i32.add
                                local.set $K0
                                i32.const 0 local.set $kpass
                                local.get $interpK
                                local.set $tailMode
                                i32.const 1 local.set $epass
                                br $e_loop))
                        br $e_exit))`
    );

    wat = replaceTails(wat, FINISH5_CALL);
    return wat;
}

function make6(from4){
    var wat = make5(from4);
    wat = wat.replace(/tetra5d_nch/g, 'tetra6d_nch');
    wat = wat.replace(/interp_tetra5d_nCh/g, 'interp_tetra6d_nCh');
    wat = wat.replace(/5D tetrahedral/g, '6D tetrahedral');
    wat = wat.replace(/\(func \$finish5[\s\S]*?\(i32\.add \(local\.get \$outputPos\) \(i32\.const 1\)\)\)/, FINISH6.trim());
    wat = wat.split(FINISH5_CALL).join(FINISH6_CALL);

    wat = wat.replace(
        '(param $maxE         i32)\n        (param $scratchPtr   i32)',
        '(param $maxE         i32)\n        (param $go5          i32)\n        (param $maxF         i32)\n        (param $scratchPtr   i32)'
    );
    wat = wat.replace(
        '(local $inputE      i32)',
        '(local $inputF      i32)\n        (local $inputE      i32)'
    );
    wat = wat.replace(
        '(local $pe          i32)',
        '(local $pf          i32)\n        (local $pe          i32)'
    );
    wat = wat.replace(
        '(local $interpE     i32)',
        '(local $interpE     i32)\n        (local $F0          i32)\n        (local $rf          i32)\n        (local $fpass       i32)\n        (local $interpF     i32)'
    );

    wat = wat.replace(
`                ;; -- Load 5 u8 input bytes: E, K, X, Y, Z ----------------
                local.get $inputPos
                i32.load8_u
                local.set $inputE`,
`                ;; -- Load 6 u8 input bytes: F, E, K, X, Y, Z -------------
                local.get $inputPos
                i32.load8_u
                local.set $inputF

                local.get $inputPos
                i32.const 1
                i32.add
                i32.load8_u
                local.set $inputE`
    );
    // offsets after F: E was at 0, now E at 1, K at 2, ... advance 6
    wat = wat.replace(
`                local.get $inputPos
                i32.const 1
                i32.add
                i32.load8_u
                local.set $inputK

                local.get $inputPos
                i32.const 2
                i32.add
                i32.load8_u
                local.set $input0

                local.get $inputPos
                i32.const 3
                i32.add
                i32.load8_u
                local.set $input1

                local.get $inputPos
                i32.const 4
                i32.add
                i32.load8_u
                local.set $input2

                local.get $inputPos
                i32.const 5
                i32.add
                local.set $inputPos`,
`                local.get $inputPos
                i32.const 2
                i32.add
                i32.load8_u
                local.set $inputK

                local.get $inputPos
                i32.const 3
                i32.add
                i32.load8_u
                local.set $input0

                local.get $inputPos
                i32.const 4
                i32.add
                i32.load8_u
                local.set $input1

                local.get $inputPos
                i32.const 5
                i32.add
                i32.load8_u
                local.set $input2

                local.get $inputPos
                i32.const 6
                i32.add
                local.set $inputPos`
    );

    wat = wat.replace(
        'local.get $inputE local.get $gps i32.mul local.set $pe',
        'local.get $inputF local.get $gps i32.mul local.set $pf\n                local.get $inputE local.get $gps i32.mul local.set $pe'
    );

    wat = wat.replace(
`                local.get $K0
                local.get $E0
                i32.add
                local.set $K0
                i32.const 0
                local.set $epass`,
`                ;; F-axis
                (if (i32.eq (local.get $inputF) (i32.const 255))
                    (then
                        local.get $maxF
                        local.set $F0
                        i32.const 0
                        local.set $rf)
                    (else
                        local.get $pf
                        i32.const 16
                        i32.shr_u
                        local.get $go5
                        i32.mul
                        local.set $F0
                        local.get $pf
                        i32.const 8
                        i32.shr_u
                        i32.const 0xFF
                        i32.and
                        local.set $rf))
                local.get $rf
                i32.const 0
                i32.ne
                local.set $interpF
                local.get $K0
                local.get $E0
                i32.add
                local.get $F0
                i32.add
                local.set $K0
                i32.const 0
                local.set $epass
                i32.const 0
                local.set $fpass`
    );

    wat = wat.replace(
`                (block $e_exit
                    (loop $e_loop`,
`                (block $f_exit
                    (loop $f_loop
                (block $e_exit
                    (loop $e_loop`
    );

    wat = wat.replace(
`                        br $e_exit))`,
`                        br $e_exit))

                        (if (i32.and
                                (i32.eqz (local.get $fpass))
                                (local.get $interpF))
                            (then
                                local.get $K0base
                                local.get $E0
                                i32.add
                                local.get $F0
                                i32.add
                                local.get $go5
                                i32.add
                                local.set $K0
                                i32.const 0 local.set $kpass
                                i32.const 0 local.set $epass
                                local.get $interpK
                                local.set $tailMode
                                i32.const 1 local.set $fpass
                                br $f_loop))
                        br $f_exit))`
    );

    // E-step on 6D must keep F0 in K0
    wat = wat.replace(
`                                local.get $K0base
                                local.get $E0
                                i32.add
                                local.get $go4
                                i32.add
                                local.set $K0
                                i32.const 0 local.set $kpass
                                local.get $interpK
                                local.set $tailMode
                                i32.const 1 local.set $epass
                                br $e_loop`,
`                                local.get $K0base
                                local.get $E0
                                i32.add
                                local.get $F0
                                i32.add
                                local.get $go4
                                i32.add
                                local.get $fpass
                                local.get $go5
                                i32.mul
                                i32.add
                                local.set $K0
                                i32.const 0 local.set $kpass
                                local.get $interpK
                                local.set $tailMode
                                i32.const 1 local.set $epass
                                br $e_loop
    );

    return wat;
}

const out5 = path.join(__dirname, '..', 'src', 'kernels', '5d', 'tetra5d_nch.wat');
const out6 = path.join(__dirname, '..', 'src', 'kernels', '6d', 'tetra6d_nch.wat');
fs.mkdirSync(path.dirname(out5), { recursive: true });
fs.mkdirSync(path.dirname(out6), { recursive: true });
fs.writeFileSync(out5, make5(src));
fs.writeFileSync(out6, make6(src));
console.log('wrote', out5);
console.log('wrote', out6);
