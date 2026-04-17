import * as E from 'ethers';
console.log(Object.keys(E));
console.log('has default:', !!E.default);
console.log('has ethers:', !!E.ethers);
console.log('typeof default:', typeof E.default);
