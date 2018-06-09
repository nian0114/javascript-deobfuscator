import * as espree from 'espree';
import * as estree from 'estree';
import { generate } from 'escodegen';
import { EspreeFacade } from './EspreeFacade';
import { StringArrayProtection } from './string-array';
import { registerDecoders } from './utils';
import { ProtectionBase } from './protection';
import { StringSplit, BooleanLiterals } from './literals';

type ProtectionCtor = new (code: string, ast: estree.Program) => ProtectionBase;

export class Deobfuscator {

    private static readonly espreeParseOptions: espree.ParseOptions = {
        attachComment: true,
        comment: true,
        ecmaFeatures: {
            experimentalObjectRestSpread: true
        },
        ecmaVersion: 9,
        loc: true,
        range: true
    };

    private ast: estree.Program | null = null;
    private protections: ProtectionCtor[] = [
        StringSplit,
        BooleanLiterals,
        StringArrayProtection,
    ];

    constructor (public code: string) {

    }

    init(): void {
        this.ast = EspreeFacade.parse(this.code, Deobfuscator.espreeParseOptions);
        registerDecoders();
    }

    deobfuscate(): string {
        if (!this.ast)
            throw new Error('Call init() first.');

        let code = this.code;
        let ast = this.ast;

        for (const ctor of this.protections) {
            const p = new ctor(code, ast);
            if (p.detect()) {
                ast = p.remove();
                code = generate(ast);
            }
        }

        return code;
    }

}
