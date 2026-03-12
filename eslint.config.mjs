import typescriptEslint from 'typescript-eslint';

export default [
	{
		files: ['**/*.ts'],
		ignores: ['out/**']
	},
	{
		files: ['**/*.ts'],
		plugins: {
			'@typescript-eslint': typescriptEslint.plugin
		},
		languageOptions: {
			parser: typescriptEslint.parser,
			ecmaVersion: 2022,
			sourceType: 'module'
		},
		rules: {
			curly: 'warn',
			eqeqeq: 'warn',
			'no-throw-literal': 'warn',
			semi: 'warn'
		}
	}
];
