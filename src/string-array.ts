import * as espree from 'espree';
import * as estree from 'estree';
import { assert } from 'console';
import { VisitorOption, traverse, replace } from 'estraverse';
import { ProtectionBase } from "./protection";
import { cutCode, decodeBase64, decodeRC4 } from './utils';

type EncodingType = 'none' | 'base64' | 'rc4';

export class StringArrayProtection extends ProtectionBase {

    private arrayVar: string = '';
    private array: string[] = [];
    private astArray: estree.Statement | null = null;

    private hasRotation: boolean = false;
    private rotFunc: string = '';
    private astRot: estree.Statement | null = null;

    private hasEncoding: boolean = false;
    private encoding: EncodingType = 'none';
    private astDecoder: estree.Statement | null = null;
    private decFuncName: string = '';
    private rc4Keys: string[] = [];

    constructor(code: string, ast: estree.Program) {
        super(code, ast);
    }
    
    detect(): boolean {
        this.active = false;
        if (this.ast.body && this.ast.body.length > 0 && this.ast.body[0].type === 'VariableDeclaration') {
            const strArrayDef = <estree.VariableDeclaration> this.ast.body[0];
            if (strArrayDef.declarations && strArrayDef.declarations.length > 0) {
                const strArrayDecl = strArrayDef.declarations[0];
                if (strArrayDecl.init && strArrayDecl.init.type === 'ArrayExpression' && strArrayDecl.id.type === 'Identifier') {
                    this.arrayVar = (<estree.Identifier> strArrayDecl.id).name;
                    this.astArray = this.ast.body[0] as estree.Statement;
                    this.array = strArrayDecl.init.elements.map(e => {
                        assert(e.type === 'Literal');
                        assert(typeof (<estree.Literal> e).value === 'string');
                        return (<estree.Literal> e).value as string;
                    });                    
                    this.active = true;
                    this.detectRotation();
                    this.detectEncoding();
                }
            }
        }
        return this.active;
    }

    private detectRotation(): boolean {
        this.hasRotation = false;
        if (this.ast.body.length > 1 && this.ast.body[1].type === 'ExpressionStatement') {
            const expr = <estree.ExpressionStatement> this.ast.body[1];
            if (expr.expression.type === 'CallExpression') {
                const call = <estree.CallExpression> expr.expression;
                if (call.arguments.length === 2) {
                    const id = <estree.Identifier> call.arguments.find(x => x.type === 'Identifier');
                    const cnt = <estree.Literal> call.arguments.find(x => x.type === 'Literal');
                    if (id && id.name === this.arrayVar && cnt && typeof cnt.value === 'number') {
                        this.hasRotation = true;
                        this.rotFunc = cutCode(this.code, expr);
                        this.astRot = this.ast.body[1] as estree.Statement;
                    }
                }
            }
        }
        return this.hasRotation;
    }

    private detectEncoding(): boolean {
        this.hasEncoding = false;
        let index = this.hasRotation ? 2 : 1;
        if (this.ast.body.length > index && this.ast.body[index].type === 'VariableDeclaration') {
            const decVar = <estree.VariableDeclaration> this.ast.body[2];
            if (decVar.declarations && decVar.declarations.length > 0) {
                const decDecl = <estree.VariableDeclarator> decVar.declarations[0];
                if (decDecl.id.type === 'Identifier' && decDecl.init && decDecl.init.type === 'FunctionExpression') {
                    const decFunc = <estree.FunctionExpression> decDecl.init;
                    if (decFunc.params.length === 2) {
                        const decFuncCode = cutCode(this.code, decFunc);
                        this.encoding = /\batob\b/.test(decFuncCode)
                            ? (/%(?:0x100|256)\D/.test(decFuncCode) ? 'rc4' : 'base64')
                            : 'none';
                        this.astDecoder = this.ast.body[index] as estree.Statement;
                        this.decFuncName = decDecl.id.name;
                        this.hasEncoding = true;
                    }
                }
            }
        }
        return this.hasEncoding;
    }

    remove(): estree.Program {
        let result = this.ast;
        if (!this.active)
            return result;

        if (this.hasRotation) {
            const func = new Function(this.arrayVar, this.rotFunc);
            func.call(undefined, this.array);
        }

        if (this.hasEncoding && this.astDecoder) {
            if (this.encoding === 'base64') {
                for (let i = 0; i < this.array.length; ++i)
                    this.array[i] = decodeBase64(this.array[i]);
            } else if (this.encoding === 'rc4') {
                this.fillKeys();
                for (let i = 0; i < this.array.length; ++i)
                    this.array[i] = decodeRC4(this.array[i], this.rc4Keys[i]);
            }
            this.removeDecoderCalls();
        }

        if (this.hasRotation && this.astRot) {
            this.ast.body.splice(this.ast.body.indexOf(this.astRot), 1);
        }

        if (this.hasEncoding && this.astDecoder) {
            this.ast.body.splice(this.ast.body.indexOf(this.astDecoder), 1);
        }

        if (this.astArray) {
            this.ast.body.splice(this.ast.body.indexOf(this.astArray), 1);
        }

        return result;
    }

    private fillKeys(): void {
        for (let i = 0; i < this.ast.body.length; ++i) {
            traverse(this.ast.body[i], {
                enter: (node, parentNode) => {
                    let call = this.checkDecoderCall(node);
                    if (call) {
                        const index = <any> (<estree.Literal> call.arguments[0]).value - 0;
                        this.rc4Keys[index] = (<estree.Literal> call.arguments[1]).value as string;
                    }
                }
            });
        }
    }

    private removeDecoderCalls(): void {
        for (let i = 0; i < this.ast.body.length; ++i) {
            this.ast.body[i] = <estree.Statement> replace(this.ast.body[i], {
                enter: (node, parentNode) => {
                    let call = this.checkDecoderCall(node);
                    if (call) {
                        const index = <any> (<estree.Literal> call.arguments[0]).value - 0;
                        return <estree.Literal> {
                            type: 'Literal',
                            value: this.array[index]
                        };
                    }
                }
            });
        }
    }

    private checkDecoderCall(node: estree.Node): estree.CallExpression | null {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
            const callee = <estree.Identifier> node.callee;
            if (callee.name === this.decFuncName) {
                const call = <estree.CallExpression> node;
                assert(call.arguments.length === 2);
                assert(call.arguments.every(x => x.type === 'Literal'));
                return call;
            }
        }
        return null;
    }
}
